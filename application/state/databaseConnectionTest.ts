/**
 * The connection editor's "Test" button, for connections that go through an
 * SSH host (a tunnel, or the on-host driver's session on the host).
 *
 * What is tested is a draft, not the saved connection, so the test brings its
 * own way to the host: it must not reuse - and on an edited draft, replace -
 * the tunnel an open tab is working through, and nothing it opened may stay
 * behind once the test has answered (for the on-host driver that is a login
 * session on the host, possibly on a bastion).
 */

import { databaseConnectionTarget } from '../../domain/models';
import type { DatabaseConnection, DbConnectionTarget, DbTestConnectionResult } from '../../domain/models';
import {
  applyDatabaseTunnel,
  type DatabaseTunnelResult,
} from '../../infrastructure/services/databaseTunnelService';

export interface DatabaseConnectionTestSteps {
  ensureTunnel: (connection: DatabaseConnection) => Promise<DatabaseTunnelResult>;
  closeTunnel: (connectionId: string) => Promise<void>;
  testTarget: (target: DbConnectionTarget) => Promise<DbTestConnectionResult>;
  /** Makes the test's tunnel key unique; defaults to a random id. */
  nonce?: () => string;
}

const failed = (error: unknown): DbTestConnectionResult => ({
  ok: false,
  durationMs: 0,
  error: error instanceof Error ? error.message : String(error),
});

export async function testDatabaseConnectionThroughHost(
  connection: DatabaseConnection,
  steps: DatabaseConnectionTestSteps,
): Promise<DbTestConnectionResult> {
  const nonce = steps.nonce ?? (() => crypto.randomUUID());
  // Tunnels are kept per connection id: a key of its own keeps this one apart.
  const probeId = `${connection.id}:test:${nonce()}`;
  let tunnel: DatabaseTunnelResult;
  try {
    tunnel = await steps.ensureTunnel({ ...connection, id: probeId });
  } catch (error) {
    return failed(error);
  }
  if (tunnel.ok !== true) return { ok: false, durationMs: 0, error: tunnel.error };
  try {
    // The target keeps the connection's own id: the bridge tests on a
    // throwaway session either way, and its messages name the connection.
    return await steps.testTarget(applyDatabaseTunnel(databaseConnectionTarget(connection), tunnel));
  } catch (error) {
    return failed(error);
  } finally {
    // Not awaited: the answer is in, closing is nobody's wait.
    void steps.closeTunnel(probeId).catch(() => undefined);
  }
}
