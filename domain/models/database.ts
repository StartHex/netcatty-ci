/**
 * Database workbench models.
 *
 * Connections are a reusable vault entity (like proxy profiles): hosts do not own
 * them, and any saved connection can be opened in the SQL workbench. Credentials
 * follow the same rules as host passwords — stored encrypted at rest, kept in
 * plaintext in renderer memory, and stripped from cloud/backup payloads when the
 * ciphertext is device-bound.
 */

/** Drivers bundled with the app. `jdbc` routes through the Java sidecar. */
export type DatabaseKind =
  | 'postgresql'
  | 'mysql'
  | 'mariadb'
  | 'oracle'
  | 'sqlserver'
  | 'sqlite'
  | 'jdbc'
  /**
   * Connects from the SSH host itself, with the database client libraries
   * installed there (DSCI / ProMDB), for databases whose port is only open to
   * that host. Nothing is forwarded: the queries run on the host.
   */
  | 'onhost';

export type DatabaseSslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

/** Free-form accent used in the vault list and the workbench tab. */
export type DatabaseColorTag = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export const DATABASE_KINDS: readonly DatabaseKind[] = [
  'postgresql',
  'mysql',
  'mariadb',
  'oracle',
  'sqlserver',
  'sqlite',
  'jdbc',
  'onhost',
] as const;

/**
 * How the on-host driver finds its database once it is on the host:
 * `config` uses an entry of the host's own `db.cfg` (where the login lives
 * too), `direct` connects with the account, type and server given here.
 */
export type OnHostDatabaseMode = 'config' | 'direct';

export const ON_HOST_DATABASE_MODES: readonly OnHostDatabaseMode[] = ['config', 'direct'] as const;

/** Database types the host's client library can open by name. */
export const ON_HOST_DATABASE_TYPES = ['dmdb', 'imdb', 'oracle', 'mysql', 'altibase', 'opengauss'] as const;

export type OnHostDatabaseType = (typeof ON_HOST_DATABASE_TYPES)[number];

/**
 * One exchange on the way to the host's shell: wait for `expect` to show up in
 * the terminal, then type `send` and press Enter. This is how a bastion's
 * "enter the address, pick the account" menu is answered. `expect` is plain
 * text, or `/pattern/flags` for a regular expression.
 */
export interface OnHostLoginStep {
  expect: string;
  send: string;
  /** How long to wait for `expect`, in milliseconds. */
  timeoutMs?: number;
}

export const ON_HOST_MAX_LOGIN_STEPS = 12;

export interface OnHostDatabaseSettings {
  mode: OnHostDatabaseMode;
  /** `config` mode: number of the `[DBnn]` entry; empty means the file's default. */
  dbNo?: number;
  /** `direct` mode. */
  dbType?: OnHostDatabaseType;
  /** `direct` mode: what the client library dials, e.g. `host:port` or a service name. */
  server?: string;
  /** A shell line run before the driver starts, e.g. `. ~/.bash_profile`. */
  envCommand?: string;
  /** Python on the host; empty tries python3, python, python2. */
  python?: string;
  loginSteps?: OnHostLoginStep[];
}

export const DATABASE_SSL_MODES: readonly DatabaseSslMode[] = [
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
] as const;

export const DATABASE_DEFAULT_PORTS: Record<Exclude<DatabaseKind, 'sqlite' | 'jdbc' | 'onhost'>, number> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  oracle: 1521,
  sqlserver: 1433,
};

/** Where a driver gets its credentials. SQLite only needs a file path. */
export function databaseKindUsesFile(kind: DatabaseKind): boolean {
  return kind === 'sqlite';
}

/** JDBC connections carry their own URL instead of host/port/database fields. */
export function databaseKindUsesJdbc(kind: DatabaseKind): boolean {
  return kind === 'jdbc';
}

/** The database is reached from the SSH host with the client libraries there. */
export function databaseKindUsesOnHost(kind: DatabaseKind): boolean {
  return kind === 'onhost';
}

/** True when the connection needs a network endpoint (host + port). */
export function databaseKindUsesNetwork(kind: DatabaseKind): boolean {
  return kind === 'postgresql' || kind === 'mysql' || kind === 'mariadb' || kind === 'oracle';
}

export function databaseDefaultPort(kind: DatabaseKind): number | undefined {
  if (kind === 'postgresql' || kind === 'mysql' || kind === 'mariadb' || kind === 'oracle') {
    return DATABASE_DEFAULT_PORTS[kind];
  }
  return undefined;
}

/**
 * Effective port with the driver default applied. Returns undefined for SQLite
 * and JDBC, where the port lives inside the URL.
 */
export function databaseEffectivePort(connection: Pick<DatabaseConnection, 'kind' | 'port'>): number | undefined {
  if (typeof connection.port === 'number' && Number.isFinite(connection.port) && connection.port > 0) {
    return Math.trunc(connection.port);
  }
  return databaseDefaultPort(connection.kind);
}

// ---------------------------------------------------------------------------
// Persisted entities
// ---------------------------------------------------------------------------

export interface DatabaseConnection {
  id: string;
  label: string;
  kind: DatabaseKind;
  /** Network endpoint for the built-in network drivers. */
  host?: string;
  port?: number;
  /** Database / service name. Oracle uses it as `service_name`. */
  database?: string;
  username?: string;
  password?: string;
  /** Mirrors host password policy: when false the password is never persisted. */
  savePassword?: boolean;
  /** Blocks non-read statements in the workbench for this connection. */
  readOnly?: boolean;
  sslMode?: DatabaseSslMode;
  /** SQLite database file; `:memory:` opens a private in-memory database. */
  sqlitePath?: string;
  /** Route the TCP connection through a saved SSH host (local port forward). */
  sshHostId?: string;
  /** JDBC-only: registered driver, URL template and connection properties. */
  jdbcDriverId?: string;
  jdbcUrl?: string;
  /** Fully-qualified driver class, e.g. com.mysql.cj.jdbc.Driver. */
  jdbcDriverClass?: string;
  /** Absolute paths of the driver jars (and any dependency jars). */
  jdbcDriverPaths?: string[];
  /** Optional JRE home used only by this connection. */
  javaPath?: string;
  jdbcProperties?: Record<string, string>;
  /**
   * Client-side text encoding used to decode server strings (`gbk`, `gb18030`,
   * `big5`, `latin1`, `utf8mb4`, ...). MySQL maps it to the connection charset,
   * JDBC to the driver `characterEncoding` property.
   */
  clientEncoding?: string;
  /** JDBC-only: keep a private in-memory database alive for the session. */
  inMemory?: boolean;
  /** JDBC-only: statements executed right after the connection opens. */
  initSql?: string;
  /** On-host only: how the driver gets to the host's shell and to the database. */
  onHost?: OnHostDatabaseSettings;
  group?: string;
  tags?: string[];
  colorTag?: DatabaseColorTag;
  order?: number;
  createdAt?: number;
  updatedAt?: number;
  /** Last time the workbench opened this connection (display only). */
  lastUsedAt?: number;
  savedQueries?: DatabaseSavedQuery[];
}

/** Named query saved with a connection (workbench "save query"). */
export interface DatabaseSavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt?: number;
}

/** A user-registered JDBC driver jar (requires a system Java 17+). */
export interface JdbcDriver {
  id: string;
  name: string;
  /** First jar path kept for older payloads; prefer `jarPaths`. */
  jarPath: string;
  /** All jars the driver needs, dependencies included. */
  jarPaths?: string[];
  driverClass?: string;
  /** Preset this driver was created from (postgres, mysql, oracle, …). */
  presetId?: string;
  sha256?: string;
  sizeBytes?: number;
  createdAt?: number;
}

// ---------------------------------------------------------------------------
// IPC payloads / results
// ---------------------------------------------------------------------------

export type DbCellValue = string | number | boolean | null;

export interface DbColumnMeta {
  name: string;
  /** Driver-reported type name, when available. */
  type?: string;
}

export interface DbQueryResult {
  columns: DbColumnMeta[];
  rows: DbCellValue[][];
  rowCount: number;
  durationMs: number;
  /** Rows were cut off by the maxRows guard. */
  truncated?: boolean;
  /** Command tag reported by the driver (SELECT, INSERT, …). */
  command?: string;
}

export interface DbExecResult {
  rowsAffected: number;
  durationMs: number;
  command?: string;
}

export interface DbTestConnectionResult {
  ok: boolean;
  durationMs: number;
  serverVersion?: string;
  error?: string;
  /** The bridge's code for the failure, when it has one. */
  errorCode?: string;
  /** More about the failure, e.g. what the host printed before a login step timed out. */
  errorDetail?: string;
}

/** Connection target used by the main process; credentials travel per call. */
export interface DbConnectionTarget {
  id: string;
  kind: DatabaseKind;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  sslMode?: DatabaseSslMode;
  sqlitePath?: string;
  jdbcDriverId?: string;
  jdbcUrl?: string;
  jdbcDriverClass?: string;
  jdbcDriverPaths?: string[];
  javaPath?: string;
  jdbcProperties?: Record<string, string>;
  clientEncoding?: string;
  inMemory?: boolean;
  initSql?: string;
  /**
   * On-host driver: the saved settings plus the one-time token of the shell
   * relay that `host`/`port` point at (see portForwardShellRelay).
   */
  onHost?: OnHostDatabaseSettings & { relayToken?: string };
  /** Already-resolved SSH jump credentials for this call. */
  ssh?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const NON_EMPTY = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

function clampPort(value: unknown): number | undefined {
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(port)) return undefined;
  const rounded = Math.trunc(port);
  if (rounded < 1 || rounded > 65535) return undefined;
  return rounded;
}

function sanitizeProperties(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof raw !== 'string') continue;
    out[name] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const ON_HOST_STEP_TIMEOUT_MIN_MS = 1000;
const ON_HOST_STEP_TIMEOUT_MAX_MS = 5 * 60 * 1000;

function sanitizeOnHostLoginSteps(value: unknown): OnHostLoginStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: OnHostLoginStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<OnHostLoginStep>;
    // What to wait for must be there; what to type may be empty (just Enter).
    const expect = typeof record.expect === 'string' ? record.expect.trim().slice(0, 200) : '';
    if (!expect) continue;
    const send = typeof record.send === 'string' ? record.send.slice(0, 500) : '';
    const timeout = Number(record.timeoutMs);
    steps.push({
      expect,
      send,
      ...(Number.isFinite(timeout) && timeout > 0
        ? {
            timeoutMs: Math.min(
              ON_HOST_STEP_TIMEOUT_MAX_MS,
              Math.max(ON_HOST_STEP_TIMEOUT_MIN_MS, Math.trunc(timeout)),
            ),
          }
        : {}),
    });
    if (steps.length >= ON_HOST_MAX_LOGIN_STEPS) break;
  }
  return steps.length > 0 ? steps : undefined;
}

export function sanitizeOnHostSettings(value: unknown): OnHostDatabaseSettings {
  const record = (value && typeof value === 'object' ? value : {}) as Partial<OnHostDatabaseSettings>;
  const mode: OnHostDatabaseMode = record.mode === 'direct' ? 'direct' : 'config';
  const dbNo = Number(record.dbNo);
  const dbType = ON_HOST_DATABASE_TYPES.includes(record.dbType as OnHostDatabaseType)
    ? (record.dbType as OnHostDatabaseType)
    : undefined;
  const server = NON_EMPTY(record.server);
  const envCommand = NON_EMPTY(record.envCommand);
  const python = NON_EMPTY(record.python);
  const loginSteps = sanitizeOnHostLoginSteps(record.loginSteps);
  return {
    mode,
    ...(mode === 'config' && Number.isInteger(dbNo) && dbNo >= 1 && dbNo <= 99 ? { dbNo } : {}),
    ...(mode === 'direct' && dbType ? { dbType } : {}),
    ...(mode === 'direct' && server ? { server: server.slice(0, 300) } : {}),
    ...(envCommand ? { envCommand: envCommand.slice(0, 2000) } : {}),
    ...(python ? { python: python.slice(0, 300) } : {}),
    ...(loginSteps ? { loginSteps } : {}),
  };
}

/**
 * Drops unknown / empty fields and normalizes the connection. Keeps encrypted
 * placeholders untouched so the persistence layer can decide what to do with
 * them (same convention as hosts and proxy profiles).
 */
export function sanitizeDatabaseConnection(
  input: Partial<DatabaseConnection> & { id: string },
): DatabaseConnection {
  const kind: DatabaseKind = DATABASE_KINDS.includes(input.kind as DatabaseKind)
    ? (input.kind as DatabaseKind)
    : 'postgresql';
  const colorTag: DatabaseColorTag | undefined =
    input.colorTag && input.colorTag !== 'none' ? (input.colorTag as DatabaseColorTag) : undefined;
  return {
    id: input.id,
    label: NON_EMPTY(input.label) ?? `${kind}`,
    kind,
    host: NON_EMPTY(input.host),
    port: clampPort(input.port),
    database: NON_EMPTY(input.database),
    username: NON_EMPTY(input.username),
    password: typeof input.password === 'string' ? input.password : undefined,
    savePassword: input.savePassword === false ? false : true,
    ...(input.readOnly === true ? { readOnly: true } : {}),
    sslMode: DATABASE_SSL_MODES.includes(input.sslMode as DatabaseSslMode)
      ? (input.sslMode as DatabaseSslMode)
      : undefined,
    sqlitePath: NON_EMPTY(input.sqlitePath),
    sshHostId: NON_EMPTY(input.sshHostId),
    jdbcDriverId: NON_EMPTY(input.jdbcDriverId),
    jdbcUrl: NON_EMPTY(input.jdbcUrl),
    jdbcDriverClass: NON_EMPTY(input.jdbcDriverClass),
    jdbcDriverPaths: Array.isArray(input.jdbcDriverPaths)
      ? input.jdbcDriverPaths
          .map(NON_EMPTY)
          .filter((path): path is string => Boolean(path))
      : undefined,
    javaPath: NON_EMPTY(input.javaPath),
    jdbcProperties: sanitizeProperties(input.jdbcProperties),
    clientEncoding: NON_EMPTY(input.clientEncoding),
    inMemory: input.inMemory === true ? true : undefined,
    initSql: NON_EMPTY(input.initSql),
    ...(kind === 'onhost' ? { onHost: sanitizeOnHostSettings(input.onHost) } : {}),
    group: NON_EMPTY(input.group),
    tags: Array.isArray(input.tags) ? input.tags.map(NON_EMPTY).filter((tag): tag is string => Boolean(tag)) : undefined,
    colorTag,
    order: typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : undefined,
    savedQueries: sanitizeSavedQueries(input.savedQueries),
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : undefined,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : undefined,
  };
}

const MAX_SAVED_QUERIES = 100;
const MAX_SAVED_QUERY_LENGTH = 20000;

function sanitizeSavedQueries(value: unknown): DatabaseSavedQuery[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: DatabaseSavedQuery[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<DatabaseSavedQuery>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const sql = typeof record.sql === 'string' ? record.sql : '';
    if (!id || !name || !sql.trim() || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, 120),
      sql: sql.slice(0, MAX_SAVED_QUERY_LENGTH),
      ...(typeof record.createdAt === 'number' ? { createdAt: record.createdAt } : {}),
    });
    if (out.length >= MAX_SAVED_QUERIES) break;
  }
  return out.length > 0 ? out : undefined;
}

export function sanitizeDatabaseConnections(input: unknown): DatabaseConnection[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: DatabaseConnection[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<DatabaseConnection> & { id?: unknown };
    const id = NON_EMPTY(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(sanitizeDatabaseConnection({ ...record, id }));
  }
  return out;
}

/**
 * Whether the connection has everything the driver needs to attempt a TCP
 * handshake. Password may be empty (trust auth / OS auth), so it is not required.
 */
export function isDatabaseConnectionReady(connection: DatabaseConnection): boolean {
  if (databaseKindUsesFile(connection.kind)) {
    return Boolean(connection.sqlitePath);
  }
  if (databaseKindUsesJdbc(connection.kind)) {
    return Boolean(connection.jdbcUrl && (connection.jdbcDriverId || connection.jdbcDriverClass));
  }
  if (databaseKindUsesOnHost(connection.kind)) {
    // The host is where the driver runs: without one there is nothing to do.
    if (!connection.sshHostId) return false;
    const settings = connection.onHost;
    if (!settings || settings.mode === 'config') return true;
    return Boolean(settings.dbType && settings.server && connection.username);
  }
  return Boolean(connection.host && (connection.username || connection.kind === 'postgresql'));
}

export function databaseDisplayTarget(connection: DatabaseConnection): string {
  if (databaseKindUsesFile(connection.kind)) {
    return connection.sqlitePath ?? ':memory:';
  }
  if (databaseKindUsesJdbc(connection.kind)) {
    return connection.jdbcUrl ?? 'jdbc:';
  }
  if (databaseKindUsesOnHost(connection.kind)) {
    const settings = connection.onHost;
    if (settings?.mode === 'direct') {
      return `${settings.dbType ?? 'db'}:${settings.server ?? ''}`;
    }
    return settings?.dbNo ? `db.cfg DB${String(settings.dbNo).padStart(2, '0')}` : 'db.cfg';
  }
  const port = databaseEffectivePort(connection);
  const hostPart = `${connection.host ?? 'localhost'}${port ? `:${port}` : ''}`;
  return connection.database ? `${hostPart}/${connection.database}` : hostPart;
}

/** Stable ordering for the vault list: explicit order, then label. */
export function sortDatabaseConnections(connections: DatabaseConnection[]): DatabaseConnection[] {
  return [...connections].sort((a, b) => {
    const orderDiff = (a.order ?? 0) - (b.order ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.label.localeCompare(b.label);
  });
}

/**
 * Project a saved connection into the credential payload the main process
 * expects. Password placeholders are never sent over IPC; the renderer resolves
 * the real secret first and passes it through `overrides`.
 */
export function databaseConnectionTarget(
  connection: DatabaseConnection,
  overrides?: { password?: string },
): DbConnectionTarget {
  return {
    id: connection.id,
    kind: connection.kind,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    password: overrides?.password ?? connection.password,
    sslMode: connection.sslMode,
    sqlitePath: connection.sqlitePath,
    jdbcDriverId: connection.jdbcDriverId,
    jdbcUrl: connection.jdbcUrl,
    jdbcDriverClass: connection.jdbcDriverClass,
    jdbcDriverPaths: connection.jdbcDriverPaths,
    javaPath: connection.javaPath,
    jdbcProperties: connection.jdbcProperties,
    clientEncoding: connection.clientEncoding,
    inMemory: connection.inMemory,
    initSql: connection.initSql,
    ...(connection.kind === 'onhost' ? { onHost: sanitizeOnHostSettings(connection.onHost) } : {}),
  };
}
