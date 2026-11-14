/**
 * Ad-hoc SSH tunnels for database connections.
 *
 * When a `DatabaseConnection` carries `tunnelHostId`, the connection is dialed
 * through an existing vault host using a dedicated local port forward. The
 * ephemeral rule never touches port-forwarding persistence: it lives only in
 * renderer memory and is stopped when the workbench closes the connection.
 */

import {
  databaseEffectivePort,
  type DatabaseConnection,
  type DbConnectionTarget,
} from '../../domain/models';
import type { PortForwardingRule } from '../../domain/models/portForwarding';
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '../../domain/models';
import { jdbcDefaultPort, parseJdbcEndpoint, rewriteJdbcUrlEndpoint } from '../../domain/database/jdbcUrl';
import { startPortForward, stopPortForward } from './portForwardingService';

export interface DatabaseTunnelDeps {
  hosts: readonly Host[];
  keys: readonly SSHKey[];
  identities: readonly Identity[];
  knownHosts?: readonly KnownHost[];
  terminalSettings?: Pick<
    TerminalSettings,
    'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'
  >;
}

interface TunnelRecord {
  ruleId: string;
  host: string;
  port: number;
  /** What the tunnel dials; an edited connection needs a new tunnel. */
  remoteHost: string;
  remotePort: number;
  sshHostId: string;
  generation: number;
}

const tunnels = new Map<string, TunnelRecord>();
/** One in-flight start per connection, so parallel callers share it. */
const pendingTunnels = new Map<string, Promise<{ ok: true; host: string; port: number } | { ok: false; error: string }>>();
let tunnelGeneration = 0;

const noopStatus = () => {};

function tunnelRuleId(connectionId: string): string {
  return `db-tunnel-${connectionId}`;
}

function buildRule(
  connection: DatabaseConnection,
  ruleId: string,
  remote: { host: string; port: number },
): PortForwardingRule {
  return {
    id: ruleId,
    label: `DB tunnel: ${connection.label}`,
    type: 'local',
    localPort: 0,
    bindAddress: '127.0.0.1',
    // JDBC connections often carry the host only inside jdbcUrl.
    remoteHost: remote.host,
    remotePort: remote.port,
    hostId: connection.sshHostId,
    status: 'inactive',
    createdAt: Date.now(),
  };
}

export const hasDatabaseTunnel = (connectionId: string): boolean => tunnels.has(connectionId);

/**
 * The host/port a connection dials, or null when it cannot be told.
 *
 * A JDBC driver only ever reads its URL, so for JDBC connections the URL wins
 * over the host/port fields: those are leftovers of the form that built the
 * URL and go stale as soon as the URL is edited by hand.
 */
export function resolveDatabaseRemoteEndpoint(
  connection: DatabaseConnection,
): { host: string; port: number } | null {
  if (connection.kind === 'jdbc') {
    const jdbc = connection.jdbcUrl ? parseJdbcEndpoint(connection.jdbcUrl) : null;
    if (!jdbc) return null;
    const port = jdbc.port
      ?? jdbcDefaultPort(connection.jdbcUrl ?? '')
      ?? databaseEffectivePort(connection);
    return port ? { host: jdbc.host, port } : null;
  }
  const port = databaseEffectivePort(connection);
  return port ? { host: connection.host || '127.0.0.1', port } : null;
}

export async function ensureDatabaseTunnel(
  connection: DatabaseConnection,
  deps: DatabaseTunnelDeps,
): Promise<{ ok: true; host: string; port: number } | { ok: false; error: string }> {
  const remote = resolveDatabaseRemoteEndpoint(connection);
  if (!connection.sshHostId) {
    return { ok: true, host: remote?.host ?? connection.host ?? '127.0.0.1', port: remote?.port ?? 0 };
  }
  if (!remote) {
    // Connecting anyway would silently bypass the SSH host.
    return {
      ok: false,
      error: connection.kind === 'jdbc'
        ? 'Cannot tell which host and port this JDBC URL connects to, so it cannot go through the SSH host. '
          + 'Write the address into the URL, for example jdbc:mysql://host:3306/db, '
          + 'jdbc:oracle:thin:@//host:1521/SERVICE or jdbc:sqlserver://host:1433;databaseName=db.'
        : 'This connection has no host and port to tunnel to',
    };
  }
  const remotePort = remote.port;
  const existing = tunnels.get(connection.id);
  if (existing) {
    const sameEndpoint = existing.remoteHost === remote.host
      && existing.remotePort === remotePort
      && existing.sshHostId === connection.sshHostId;
    if (sameEndpoint) return { ok: true, host: existing.host, port: existing.port };
    // The connection was edited (other jump host / database endpoint):
    // keeping the old forward would silently dial the old server.
    await closeDatabaseTunnel(connection.id);
  }
  const pending = pendingTunnels.get(connection.id);
  if (pending) return pending;
  const opening = openDatabaseTunnel(connection, deps, remote).finally(() => {
    if (pendingTunnels.get(connection.id) === opening) pendingTunnels.delete(connection.id);
  });
  pendingTunnels.set(connection.id, opening);
  return opening;
}

async function openDatabaseTunnel(
  connection: DatabaseConnection,
  deps: DatabaseTunnelDeps,
  remote: { host: string; port: number },
): Promise<{ ok: true; host: string; port: number } | { ok: false; error: string }> {
  const jumpHost = deps.hosts.find((host) => host.id === connection.sshHostId);
  if (!jumpHost) {
    return { ok: false, error: 'The SSH host used for this tunnel no longer exists' };
  }

  const ruleId = tunnelRuleId(connection.id);
  const rule = buildRule(connection, ruleId, remote);
  const generation = ++tunnelGeneration;
  // A forward that dies (SSH drop, sleep/resume) is forgotten, so the next
  // query or the idle probe dials a fresh tunnel instead of a dead local port.
  const onStatusChange = (status: PortForwardingRule['status']) => {
    if (status !== 'error' && status !== 'inactive') return;
    const current = tunnels.get(connection.id);
    if (current && current.generation === generation) tunnels.delete(connection.id);
  };
  let started: Awaited<ReturnType<typeof startPortForward>>;
  try {
    started = await startPortForward(
      rule,
      jumpHost,
      [...deps.hosts],
      [...deps.keys],
      [...deps.identities],
      onStatusChange,
      false,
      deps.terminalSettings,
      deps.knownHosts ? [...deps.knownHosts] : undefined,
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!started.success) {
    const via = jumpHost.label || jumpHost.hostname;
    return {
      ok: false,
      error: `SSH tunnel to ${remote.host}:${remote.port} via ${via} failed: ${started.error || 'unknown error'}`,
    };
  }
  const localPort = started.localPort;
  if (!localPort) {
    await stopPortForward(ruleId, noopStatus).catch(() => undefined);
    return { ok: false, error: 'The SSH tunnel did not report a local port' };
  }
  const record: TunnelRecord = {
    ruleId,
    host: '127.0.0.1',
    port: localPort,
    remoteHost: remote.host,
    remotePort: remote.port,
    sshHostId: connection.sshHostId ?? '',
    generation,
  };
  tunnels.set(connection.id, record);
  return { ok: true, host: record.host, port: record.port };
}

export async function closeDatabaseTunnel(connectionId: string): Promise<void> {
  const record = tunnels.get(connectionId);
  if (!record) return;
  tunnels.delete(connectionId);
  await stopPortForward(record.ruleId, noopStatus).catch(() => undefined);
}

export async function closeAllDatabaseTunnels(): Promise<void> {
  const ids = [...tunnels.keys()];
  await Promise.all(ids.map((id) => closeDatabaseTunnel(id)));
}

/** Rewrite a connection target to the tunneled endpoint when one is active. */
export function applyDatabaseTunnel(
  target: DbConnectionTarget,
  tunnel: { host: string; port: number } | null,
): DbConnectionTarget {
  if (!tunnel) return target;
  // JDBC drivers read host/port from the URL, so rewrite it as well.
  const jdbcUrl = target.jdbcUrl
    ? rewriteJdbcUrlEndpoint(target.jdbcUrl, tunnel.host, tunnel.port)
    : undefined;
  return { ...target, host: tunnel.host, port: tunnel.port, ...(jdbcUrl ? { jdbcUrl } : {}) };
}
