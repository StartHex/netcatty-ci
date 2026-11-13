"use strict";

const { readDriverClassesFromJar } = require("./jdbcJar.cjs");
const { resolveJava } = require("./javaRuntime.cjs");

/**
 * Database bridge — main-process side of the SQL workbench.
 *
 * Drivers are loaded lazily so a missing native dependency only breaks the
 * affected database kind instead of the whole app. Connections are pooled per
 * connection id (one live session at a time, queries serialized), and every
 * handler returns a plain JSON object the renderer can render directly.
 *
 * Security: the renderer resolves credentials (vault decryption, SSH auth) and
 * passes them per call. Nothing is persisted here.
 */

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");


/** Append length/precision to a base SQL type so the schema tree shows `char(10)`. */
function withTypeSize(type, size, scale) {
  const base = String(type || "");
  if (!base) return base;
  const sized = /char|binary|text|bit|varbinary|varchar/i.test(base);
  const numeric = /decimal|numeric|number/i.test(base);
  const length = Number(size);
  if (sized && Number.isFinite(length) && length > 0) return `${base}(${length})`;
  if (numeric && Number.isFinite(length) && length > 0) {
    const digits = Number(scale);
    return Number.isFinite(digits) && digits > 0 ? `${base}(${length},${digits})` : `${base}(${length})`;
  }
  return base;
}


let mysqlTypeNames = null;
/** mysql2 reports numeric field types; expose readable names when possible. */
function mysqlTypeName(code) {
  if (!mysqlTypeNames) {
    try {
      const { Types } = require("mysql2");
      mysqlTypeNames = new Map(Object.entries(Types).map(([name, value]) => [value, name.toLowerCase()]));
    } catch {
      mysqlTypeNames = new Map();
    }
  }
  return mysqlTypeNames.get(Number(code)) ?? String(code ?? "");
}

const CTE_STATEMENT_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
const SQL_LEADING_NOISE = /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)*/;

/**
 * Transaction boundary a hand-typed statement creates, so the workbench badge
 * follows `BEGIN` / `COMMIT` typed in the editor, not only the toolbar buttons.
 * Oracle `BEGIN` opens a PL/SQL block (its transactions start implicitly),
 * SQL Server manages its own, and generic JDBC dialects are unknown.
 */
function transactionEffectOf(kind, sql) {
  if (kind === "sqlserver" || kind === "jdbc") return null;
  const head = String(sql || "").replace(SQL_LEADING_NOISE, "").replace(/;\s*$/, "").trim();
  if (!head) return null;
  if (/^(rollback|commit)\s+(to|prepared)\b/i.test(head)) return null;
  if (/^(rollback|abort)\b/i.test(head)) return kind === "oracle" || kind === "postgresql" || !/^abort/i.test(head) ? "rollback" : null;
  if (/^commit\b/i.test(head)) return "commit";
  if (/^end(\s+(work|transaction))?$/i.test(head)) return kind === "postgresql" || kind === "sqlite" ? "commit" : null;
  if (kind === "oracle") return null;
  if (/^start\s+transaction\b/i.test(head)) return kind === "sqlite" ? null : "begin";
  // Top-level BEGIN starts a transaction everywhere except Oracle (handled above).
  if (/^begin\b/i.test(head)) return "begin";
  return null;
}

/**
 * Best-effort command label for a statement that returned no result set, so the
 * UI can tell an UPDATE apart from a CREATE. Drivers disagree on this: postgres
 * reports `command` itself, most others leave the caller to infer it.
 */
function commandFromSql(sql) {
  const head = String(sql || "").replace(SQL_LEADING_NOISE, "");
  const first = /^([a-zA-Z]+)/.exec(head);
  if (!first) return "OK";
  const keyword = first[1].toUpperCase();
  if (keyword !== "WITH") return keyword;
  // The verb that follows a CTE lives at paren depth 0; the SELECTs inside the
  // CTE definitions are nested, so scan depth-aware instead of regex-matching.
  let depth = 0;
  for (let index = 0; index < head.length; index += 1) {
    const char = head[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || index === 0 || /[A-Za-z0-9_$]/.test(head[index - 1])) continue;
    const word = /^[A-Za-z]+/.exec(head.slice(index));
    if (!word) continue;
    const upper = word[0].toUpperCase();
    if (CTE_STATEMENT_VERBS.has(upper)) return upper;
    index += word[0].length - 1;
  }
  return keyword;
}

/**
 * Shape a mysql2 query result. mysql2 returns rows (object array) for a single
 * SELECT, an OkPacket object for DML/DDL, and — because multipleStatements is
 * enabled — an array of result sets for multi-statement scripts.
 */
function shapeMysqlResult(result, fields, maxRows, startedAt, sql) {
  const fieldSets = Array.isArray(fields) ? fields : [];
  const multiStatement = Array.isArray(fieldSets[0]);

  if (multiStatement) {
    const lastResult = Array.isArray(result) ? result[result.length - 1] : result;
    const lastFields = fieldSets[fieldSets.length - 1] || [];
    if (!Array.isArray(lastResult)) {
      return {
        columns: [],
        rows: [],
        rowCount: Number(lastResult?.affectedRows ?? 0),
        truncated: false,
        command: commandFromSql(sql),
        durationMs: Date.now() - startedAt,
      };
    }
    return buildSelectResult(lastResult, lastFields, maxRows, startedAt);
  }

  // Single statement: rows for SELECT, OkPacket otherwise.
  if (!Array.isArray(result)) {
    return {
      columns: [],
      rows: [],
      rowCount: Number(result?.affectedRows ?? 0),
      truncated: false,
      command: commandFromSql(sql),
      durationMs: Date.now() - startedAt,
    };
  }
  return buildSelectResult(result, fieldSets, maxRows, startedAt);
}

function buildSelectResult(rowObjects, fields, maxRows, startedAt) {
  const columns = Array.isArray(fields) ? fields : [];
  const names = columns.map((field) => field.name);
  const sliced = rowObjects.slice(0, maxRows);
  return {
    columns: columns.map((field) => ({ name: field.name, type: mysqlTypeName(field.type) })),
    rows: rowsToMatrix(sliced, names),
    rowCount: rowObjects.length,
    truncated: sliced.length < rowObjects.length,
    command: "SELECT",
    durationMs: Date.now() - startedAt,
  };
}

const DEFAULT_MAX_ROWS = 1000;
const HARD_MAX_ROWS = 5000;
/**
 * Tables listed in the schema panel. This is not a result set, so the row
 * cap above does not apply: a schema with more tables than that used to be
 * cut off, and the missing tables could not be found by the panel's search.
 */
const SCHEMA_TABLE_LIMIT = 100000;
const DEFAULT_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 15000;
/** Upper bound for a test / connect round-trip (connect + version query). */
const CONNECT_ROUNDTRIP_TIMEOUT_MS = 45000;
/** Schema tree / structure lookups. */
const METADATA_TIMEOUT_MS = 60000;
/** BEGIN / COMMIT / ROLLBACK; can queue behind a running statement. */
const CONTROL_TIMEOUT_MS = 60000;
/** How long a cancelled statement may take to wind down before the session is reset. */
const CANCEL_SETTLE_MS = 5000;
/** A graceful close that takes longer than this is forced. */
const CLOSE_TIMEOUT_MS = 3000;
/** JDBC gets its own driver-side statement timeout first; the bridge waits a bit longer. */
const JDBC_TIMEOUT_GRACE_MS = 3000;

const sessions = new Map();

/** Resolves true when `promise` settles within `ms`, false otherwise (never rejects). */
function settleWithin(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Resolves true only when `promise` fulfils within `ms` (never rejects). */
function resolvesWithin(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Graceful close with a deadline, then the driver's hard close. Never throws. */
async function closeSessionSafely(session) {
  if (!session) return;
  let closing;
  try {
    closing = Promise.resolve(session.close());
  } catch {
    closing = Promise.resolve();
  }
  const graceful = await settleWithin(closing, CLOSE_TIMEOUT_MS);
  if (!graceful) {
    try {
      await session.forceClose?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Everything that decides which server/session a target dials. A cached
 * session whose fingerprint no longer matches (edited password, host,
 * charset, ...) is replaced instead of silently reused. Hashed so the
 * password is not kept around as another plain string.
 */
function connectionFingerprint(target) {
  const relevant = [
    target.kind,
    target.host,
    target.port,
    target.database,
    target.username,
    target.password,
    target.sslMode,
    target.sqlitePath,
    target.inMemory,
    target.jdbcUrl,
    target.jdbcDriverClass,
    target.jdbcDriverPaths,
    target.javaPath,
    target.jdbcProperties,
    target.clientEncoding,
    target.initSql,
  ];
  return crypto.createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Small helpers (exported for tests)
// ---------------------------------------------------------------------------

function clampMaxRows(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ROWS;
  return Math.min(Math.trunc(n), HARD_MAX_ROWS);
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.trunc(n), 10 * 60 * 1000);
}

function toCellValue(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : String(value);
  if (type === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) return value.map(toCellValue);
  if (type === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function normalizeError(error) {
  if (!error) return { message: "Unknown database error" };
  let message = String(error.message || error);
  // JDBC drivers that ship native libraries fail with a dlopen arch mismatch.
  // Say what to do instead of echoing the loader path.
  if (/incompatible architecture|mach-o file|dlopen\(/i.test(message)) {
    message = `${message}\n提示：该 JDBC 驱动自带的本地库与当前 Java 架构不一致（Apple Silicon 上多为 x86_64 库），请安装或指定 x86_64 的 Java（Rosetta）后重试。`;
  }
  return {
    message,
    code: typeof error.code === "string" ? error.code : undefined,
    sqlState: typeof error.sqlState === "string" ? error.sqlState : undefined,
    position:
      typeof error.position === "number" || typeof error.position === "string"
        ? error.position
        : undefined,
    detail: typeof error.detail === "string" ? error.detail : undefined,
    hint: typeof error.hint === "string" ? error.hint : undefined,
  };
}

function failure(error) {
  return { ok: false, error: normalizeError(error) };
}

/** Map generic sslMode to pg-style ssl options. */
function pgSslOptions(mode) {
  switch (mode) {
    case "disable":
      return false;
    case "require":
    case "prefer":
      return { rejectUnauthorized: false };
    case "verify-ca":
      return { rejectUnauthorized: true };
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return undefined;
  }
}

/** Map generic sslMode to mysql2-style ssl options. */
function mysqlSslOptions(mode) {
  switch (mode) {
    case "disable":
      return undefined;
    case "require":
    case "prefer":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return undefined;
  }
}

function rowsToMatrix(rows, columnNames) {
  return rows.map((row) => columnNames.map((name) => toCellValue(row?.[name])));
}

function numberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Driver sessions
// ---------------------------------------------------------------------------

function createPgSession(target) {
  const { Client } = require("pg");
  let client = null;
  let connecting = null;
  // Bumped for every physical connection, so the bridge can tell when an open
  // transaction silently vanished with a dropped socket.
  let generation = 0;

  const clientConfig = (overrides = {}) => ({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.username,
    password: target.password,
    ssl: pgSslOptions(target.sslMode),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    keepAlive: true,
    application_name: "Netcatty",
    ...overrides,
  });

  const destroyInstance = (instance) => {
    try {
      instance?.connection?.stream?.destroy();
    } catch {
      /* ignore */
    }
  };

  async function ensure() {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      const instance = new Client(clientConfig());
      // Only forget the client that actually failed: an old instance erroring
      // late (after cancel or reconnect) must not orphan the new connection.
      instance.on("error", () => {
        if (client === instance) client = null;
      });
      instance.on("end", () => {
        if (client === instance) client = null;
      });
      await instance.connect();
      client = instance;
      generation += 1;
      return instance;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    kind: "postgresql",
    ensure,
    generation: () => generation,
    async serverVersion() {
      const instance = await ensure();
      const result = await instance.query("select version() as version");
      return String(result.rows?.[0]?.version || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      const started = Date.now();
      const result = await instance.query(sql);
      const results = Array.isArray(result) ? result : [result];
      const last = results[results.length - 1] || {};
      const fields = last.fields || [];
      const names = fields.map((field) => field.name);
      const rows = (last.rows || []).slice(0, maxRows).map((row) => names.map((name) => toCellValue(row[name])));
      const total = Number.isFinite(last.rowCount) ? last.rowCount : rows.length;
      return {
        columns: fields.map((field) => ({ name: field.name, type: String(field.dataTypeID ?? "") })),
        rows,
        rowCount: total,
        truncated: rows.length < (last.rows?.length || 0) || total > rows.length,
        command: last.command,
        durationMs: Date.now() - started,
      };
    },
    async tables() {
      const instance = await ensure();
      const result = await instance.query(
        "select table_schema as schema, table_name as name, table_type as type " +
          "from information_schema.tables " +
          "where table_schema not in ('pg_catalog', 'information_schema') " +
          "order by table_schema, table_name",
      );
      return result.rows.map((row) => ({
        schema: row.schema,
        name: row.name,
        type: String(row.type || "").includes("VIEW") ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const result = await instance.query(
        "select c.column_name as name, c.data_type as type, c.is_nullable as nullable, " +
          "c.character_maximum_length as size, c.numeric_precision as precision, c.numeric_scale as scale, " +
          "exists (" +
          "  select 1 from information_schema.table_constraints tc " +
          "  join information_schema.key_column_usage kcu " +
          "    on kcu.constraint_schema = tc.constraint_schema " +
          "   and kcu.constraint_name = tc.constraint_name " +
          "   and kcu.table_name = tc.table_name " +
          "  where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema " +
          "    and tc.table_name = c.table_name and kcu.column_name = c.column_name" +
          ") as is_pk " +
          "from information_schema.columns c where c.table_schema = $1 and c.table_name = $2 " +
          "order by c.ordinal_position",
        [schema, table],
      );
      return result.rows.map((row) => ({
        name: row.name,
        type: withTypeSize(row.type, row.size ?? row.precision, row.scale),
        nullable: row.nullable === "YES",
        primaryKey: row.is_pk === true,
      }));
    },
    async control(action) {
      const instance = await ensure();
      const statement =
        action === "begin" ? "BEGIN" : action === "commit" ? "COMMIT" : "ROLLBACK";
      await instance.query(statement);
    },
    /**
     * Cancels the running statement through a side connection
     * (pg_cancel_backend), which keeps the session — and an open transaction —
     * alive. Dropping the socket is only the fallback.
     */
    async cancel() {
      const instance = client;
      if (!instance) return;
      const pid = instance.processID;
      if (pid) {
        const canceller = new Client(clientConfig({
          connectionTimeoutMillis: 5000,
          keepAlive: false,
          application_name: "Netcatty (cancel)",
        }));
        canceller.on("error", () => {});
        try {
          const cancelled = await resolvesWithin(
            canceller.connect().then(() => canceller.query("select pg_cancel_backend($1)", [pid])),
            5000,
          );
          if (cancelled) return;
        } catch {
          /* fall back below */
        } finally {
          canceller.end().catch(() => destroyInstance(canceller));
        }
      }
      if (client === instance) client = null;
      destroyInstance(instance);
    },
    forceClose() {
      const instance = client;
      client = null;
      destroyInstance(instance);
    },
    async close() {
      const instance = client;
      client = null;
      if (!instance) return;
      try {
        await instance.end();
      } catch {
        destroyInstance(instance);
      }
    },
  };
}

function createMysqlSession(target) {
  const mysql = require("mysql2/promise");
  let connection = null;
  let connecting = null;
  let generation = 0;

  const connectionConfig = (overrides = {}) => ({
    host: target.host,
    port: target.port,
    user: target.username,
    password: target.password,
    database: target.database,
    ssl: mysqlSslOptions(target.sslMode),
    connectTimeout: CONNECT_TIMEOUT_MS,
    multipleStatements: true,
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    // A client charset on the connection tells both sides how to decode
    // strings (gbk / gb18030 / big5 / latin1 / utf8mb4, ...).
    ...(target.clientEncoding ? { charset: target.clientEncoding } : {}),
    ...overrides,
  });

  /** mysql2 keeps a closed connection object around; detect it before reuse. */
  const isDead = (instance) => {
    const inner = instance?.connection;
    return Boolean(inner && (inner._fatalError || inner._closing || inner.stream?.destroyed));
  };

  const destroyInstance = (instance) => {
    try {
      instance?.destroy?.();
    } catch {
      /* ignore */
    }
  };

  async function ensure() {
    if (connection && isDead(connection)) connection = null;
    if (connection) return connection;
    if (connecting) return connecting;
    connecting = (async () => {
      const instance = await mysql.createConnection(connectionConfig());
      // Without a listener, an idle disconnect (wait_timeout, server restart)
      // is an unhandled 'error' event in the main process.
      instance.on("error", () => {
        if (connection === instance) connection = null;
      });
      connection = instance;
      generation += 1;
      return instance;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    kind: "mysql",
    ensure,
    generation: () => generation,
    async serverVersion() {
      const instance = await ensure();
      const [rows] = await instance.query("select version() as version");
      return String(rows?.[0]?.version || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      const started = Date.now();
      const [result, fields] = await instance.query(sql);
      return shapeMysqlResult(result, fields, maxRows, started, sql);
    },
    async tables() {
      const instance = await ensure();
      const [rows] = await instance.query(
        "select table_schema as `schema`, table_name as name, table_type as type " +
          "from information_schema.tables " +
          "where table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys') " +
          "order by table_schema, table_name",
      );
      return (rows || []).map((row) => ({
        schema: row.schema,
        name: row.name,
        type: String(row.type || "").includes("VIEW") ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const [rows] = await instance.query(
        "select c.column_name as name, c.column_type as type, c.is_nullable as nullable, " +
          "exists (" +
          "  select 1 from information_schema.key_column_usage kcu " +
          "  where kcu.constraint_name = 'PRIMARY' and kcu.table_schema = c.table_schema " +
          "    and kcu.table_name = c.table_name and kcu.column_name = c.column_name" +
          ") as is_pk " +
          "from information_schema.columns c where c.table_schema = ? and c.table_name = ? " +
          "order by c.ordinal_position",
        [schema, table],
      );
      return (rows || []).map((row) => ({
        name: row.name,
        type: row.type,
        nullable: row.nullable === "YES",
        primaryKey: Number(row.is_pk) === 1,
      }));
    },
    /**
     * KILL QUERY from a side connection stops the statement but keeps the
     * session and its transaction; dropping the socket is the fallback.
     */
    async cancel() {
      const instance = connection;
      if (!instance) return;
      const threadId = Number(instance.connection?.threadId ?? instance.threadId);
      if (Number.isInteger(threadId) && threadId > 0) {
        let killer = null;
        let abandoned = false;
        try {
          const killed = await resolvesWithin(
            mysql.createConnection(connectionConfig({ connectTimeout: 5000, multipleStatements: false }))
              .then((created) => {
                created.on("error", () => {});
                if (abandoned) {
                  // Connected after we gave up: do not leak it.
                  created.end().catch(() => destroyInstance(created));
                  return undefined;
                }
                killer = created;
                return killer.query(`KILL QUERY ${threadId}`);
              }),
            5000,
          );
          if (killed) return;
        } catch {
          /* fall back below */
        } finally {
          abandoned = true;
          if (killer) killer.end().catch(() => destroyInstance(killer));
        }
      }
      if (connection === instance) connection = null;
      destroyInstance(instance);
    },
    async control(action) {
      const instance = await ensure();
      if (action === "begin") await instance.beginTransaction();
      else if (action === "commit") await instance.commit();
      else await instance.rollback();
    },
    forceClose() {
      const instance = connection;
      connection = null;
      destroyInstance(instance);
    },
    async close() {
      const instance = connection;
      connection = null;
      if (!instance) return;
      try {
        await instance.end();
      } catch {
        destroyInstance(instance);
      }
    },
  };
}

function createOracleSession(target) {
  const oracledb = require("oracledb");
  let connection = null;
  let connecting = null;
  let generation = 0;

  function connectString() {
    const port = target.port || 1521;
    const service = target.database || "ORCL";
    return `${target.host}:${port}/${service}`;
  }

  async function ensure() {
    if (connection) return connection;
    if (connecting) return connecting;
    connecting = (async () => {
      oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
      const instance = await oracledb.getConnection({
        user: target.username,
        password: target.password,
        connectString: connectString(),
        // Seconds; an unreachable listener otherwise waits for the OS default.
        connectTimeout: Math.ceil(CONNECT_TIMEOUT_MS / 1000),
      });
      connection = instance;
      generation += 1;
      return instance;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    kind: "oracle",
    ensure,
    generation: () => generation,
    async serverVersion() {
      const instance = await ensure();
      const result = await instance.execute("select banner from v$version where rownum = 1");
      return String(result.rows?.[0]?.[0] || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      const started = Date.now();
      const result = await instance.execute(sql, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        maxRows,
        fetchArraySize: Math.min(maxRows, 200),
      });
      const names = (result.metaData || []).map((meta) => meta.name);
      const rows = (result.rows || []).map((row) => row.map(toCellValue));
      return {
        columns: (result.metaData || []).map((meta) => ({ name: meta.name, type: meta.dbTypeName || "" })),
        rows,
        rowCount: Number.isFinite(result.rowsAffected) && result.rowsAffected > 0
          ? result.rowsAffected
          : rows.length,
        truncated: rows.length >= maxRows,
        command: (result.metaData || []).length > 0 ? "SELECT" : commandFromSql(sql),
        durationMs: Date.now() - started,
      };
    },
    async tables() {
      const instance = await ensure();
      const result = await instance.execute(
        "select owner as schema, table_name as name, 'table' as type from all_tables " +
          "where owner not in ('SYS', 'SYSTEM', 'XDB', 'MDSYS', 'CTXSYS', 'ORDSYS') " +
          "order by owner, table_name",
        [],
        { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: SCHEMA_TABLE_LIMIT },
      );
      return (result.rows || []).map((row) => ({
        schema: String(row[0] || ""),
        name: String(row[1] || ""),
        type: "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const result = await instance.execute(
        "select c.column_name, c.data_type, c.nullable, c.data_length, c.char_length, c.data_precision, c.data_scale, " +
          "(select count(*) from all_cons_columns cc " +
          "  join all_constraints con on con.owner = cc.owner and con.constraint_name = cc.constraint_name " +
          "  where con.constraint_type = 'P' and cc.owner = c.owner and cc.table_name = c.table_name " +
          "    and cc.column_name = c.column_name) as pk " +
          "from all_tab_columns c where c.owner = :1 and c.table_name = :2 order by c.column_id",
        [schema, table],
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return (result.rows || []).map((row) => {
        const baseType = String(row[1] || "");
        const charLength = Number(row[4]) || Number(row[3]);
        const precision = Number(row[5]);
        const size = /char/i.test(baseType) ? charLength : precision;
        return {
          name: String(row[0] || ""),
          type: withTypeSize(baseType, size, row[6]),
          nullable: row[2] === "Y",
          primaryKey: Number(row[7]) > 0,
        };
      });
    },
    async control(action) {
      const instance = await ensure();
      if (action === "commit") await instance.commit();
      else if (action === "rollback") await instance.rollback();
      // Oracle starts a transaction implicitly on the first DML statement.
    },
    cancel() {
      try {
        connection?.break?.(() => {});
      } catch {
        /* ignore */
      }
    },
    forceClose() {
      const instance = connection;
      connection = null;
      // node-oracledb has no socket handle to destroy; drop the reference and
      // let a background close finish whenever the server answers.
      instance?.close?.().catch?.(() => {});
    },
    async close() {
      const instance = connection;
      connection = null;
      if (!instance) return;
      try {
        await instance.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function createSqliteSession(target) {
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("SQLite support is unavailable in this build (node:sqlite missing)");
  }

  const file = target.sqlitePath || ":memory:";
  const db = new DatabaseSync(file);

  let closed = false;
  return {
    kind: "sqlite",
    ensure: async () => db,
    generation: () => 1,
    async serverVersion() {
      const row = db.prepare("select sqlite_version() as version").get();
      return String(row?.version || "");
    },
    async query(sql, { maxRows }) {
      const started = Date.now();
      const statement = db.prepare(sql);
      const columns = typeof statement.columns === "function" ? statement.columns() : [];
      if (columns.length === 0) {
        const info = statement.run();
        return {
          columns: [],
          rows: [],
          rowCount: Number(info?.changes ?? 0),
          truncated: false,
          command: commandFromSql(sql),
          durationMs: Date.now() - started,
        };
      }
      const names = columns.map((column) => column.name);
      const all = statement.all();
      const sliced = all.slice(0, maxRows);
      return {
        columns: columns.map((column) => ({ name: column.name, type: column.type || "" })),
        rows: sliced.map((row) => names.map((name) => toCellValue(row[name]))),
        rowCount: all.length,
        truncated: sliced.length < all.length,
        command: "SELECT",
        durationMs: Date.now() - started,
      };
    },
    async tables() {
      const rows = db
        .prepare(
          "select name, type from sqlite_master where type in ('table', 'view') " +
            "and name not like 'sqlite_%' order by name",
        )
        .all();
      return rows.map((row) => ({
        schema: "main",
        name: String(row.name),
        type: row.type === "view" ? "view" : "table",
      }));
    },
    async columns(_schema, table) {
      const rows = db.prepare(`pragma table_info(${JSON.stringify(table)})`).all();
      return rows.map((row) => ({
        name: String(row.name),
        type: String(row.type || ""),
        nullable: Number(row.notnull) === 0,
        primaryKey: Number(row.pk) > 0,
      }));
    },
    async control(action) {
      const statement =
        action === "begin" ? "BEGIN" : action === "commit" ? "COMMIT" : "ROLLBACK";
      db.exec(statement);
    },
    cancel() {
      /* synchronous driver: nothing to cancel */
    },
    forceClose() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

function createJdbcSession(target) {
  const { JdbcSidecar } = require("./jdbcSidecar.cjs");
  const { listJavaCandidates } = require("./javaRuntime.cjs");
  let connecting = null;
  let generation = 0;
  let inTransaction = false;
  let busy = 0;
  // Bumped by cancel(): a request that dies with the killed sidecar must not
  // be replayed on a fresh one.
  let cancelEpoch = 0;
  // A JVM crash used to leave `connecting` resolved, so every later query
  // reported sidecar-exit without ever restarting the sidecar.
  const onSidecarExit = () => {
    connecting = null;
  };
  let sidecar = new JdbcSidecar({
    javaPath: target.javaPath,
    onExit: onSidecarExit,
  });
  const connId = "conn-1";
  // x86_64-only driver libraries cannot load into an arm64 JVM. Remember which
  // runtime worked (or failed) so retries do not reopen a doomed process.
  const rejectedJava = new Set();

  const connectOn = async (instance) => {
    const started = await instance.start();
    if (!started.ok) {
      const error = new Error(started.error || "JDBC sidecar failed to start");
      error.code = started.code || "jdbc-unavailable";
      throw error;
    }
    const extraProps = {
      ...(target.jdbcProperties ?? {}),
      ...(target.clientEncoding ? { characterEncoding: target.clientEncoding } : {}),
    };
    const response = await instance.request("CONNECT", {
      connId,
      url: target.jdbcUrl,
      ...Object.fromEntries(
        Object.entries(extraProps).map(([key, value]) => [`prop.${key}`, String(value)]),
      ),
      user: target.username,
      password: target.password,
      driverClass: target.jdbcDriverClass,
      loginTimeoutSec: Math.ceil(CONNECT_TIMEOUT_MS / 1000),
      jars: Array.isArray(target.jdbcDriverPaths)
        ? target.jdbcDriverPaths.join(require("node:path").delimiter)
        : target.jdbcDriverPaths,
    });
    if (!response.ok) {
      const error = new Error(response.error?.message || "JDBC connect failed");
      error.code = response.error?.code || "jdbc-error";
      error.sqlState = response.error?.sqlState;
      throw error;
    }
    return response.fields || {};
  };

  const isArchMismatch = (error) =>
    /incompatible architecture|mach-o file|wrong ELF class|Can't load AMD 64/i.test(
      String(error?.message || ""),
    );

  const connectWithFallback = async () => {
    try {
      return await connectOn(sidecar);
    } catch (error) {
      if (!isArchMismatch(error)) throw error;
      const currentPath = sidecar.java?.path;
      if (currentPath) rejectedJava.add(currentPath);
      for (const candidate of listJavaCandidates({})) {
        if (rejectedJava.has(candidate)) continue;
        const next = new JdbcSidecar({ javaPath: candidate, onExit: onSidecarExit });
        try {
          const fields = await connectOn(next);
          const previous = sidecar;
          sidecar = next;
          try {
            await previous.stop();
          } catch {
            /* ignore */
          }
          return fields;
        } catch (retryError) {
          rejectedJava.add(candidate);
          try {
            await next.stop();
          } catch {
            /* ignore */
          }
        }
      }
      throw error;
    }
  };

  const ensure = () => {
    if (!connecting) {
      const pending = connectWithFallback().then((fields) => {
        generation += 1;
        inTransaction = false;
        return fields;
      });
      connecting = pending;
      // A failed connect must be retried by the next call, not cached.
      pending.catch(() => {
        if (connecting === pending) connecting = null;
      });
    }
    return connecting;
  };

  const requestWithRestart = async (method, params) => {
    const epoch = cancelEpoch;
    busy += 1;
    try {
      await ensure();
      let response = await sidecar.request(method, params);
      if (!response.ok && response.error?.code === "sidecar-exit") {
        if (epoch !== cancelEpoch) {
          return { ok: false, error: { message: "Query cancelled", code: "query-cancelled" } };
        }
        // Replaying inside a lost transaction would run it in auto-commit
        // mode on a fresh connection; report the crash instead.
        if (inTransaction) return response;
        connecting = null;
        await ensure();
        response = await sidecar.request(method, params);
      }
      return response;
    } finally {
      busy -= 1;
    }
  };

  const fail = (response, fallback) => {
    const error = new Error(response.error?.message || fallback);
    error.code = response.error?.code || "jdbc-error";
    error.sqlState = response.error?.sqlState;
    return error;
  };

  return {
    kind: "jdbc",
    ensure,
    generation: () => generation,
    async serverVersion() {
      const fields = await ensure();
      const product = fields.product || "JDBC";
      const version = fields.version || "";
      return version ? `${product} ${version}` : product;
    },
    async query(sql, { maxRows, timeoutMs }) {
      const started = Date.now();
      const response = await requestWithRestart("QUERY", {
        connId,
        sql,
        maxRows,
        ...(timeoutMs ? { timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)) } : {}),
      });
      if (!response.ok) throw fail(response, "JDBC query failed");
      // Statements without a result set (INSERT/UPDATE/DDL) come back as a
      // `fields.update` tail carrying the driver's update count.
      if (response.fields?.update === "true") {
        return {
          columns: [],
          rows: [],
          rowCount: Number(response.fields?.rows || 0),
          truncated: false,
          command: commandFromSql(sql),
          durationMs: Date.now() - started,
        };
      }
      const columns = response.columns || [];
      const truncated = response.fields?.truncated === "true";
      const rows = (response.rows || []).map((row) =>
        row.map((cell) => (cell === null || cell === undefined ? null : cell)),
      );
      return {
        columns: columns.map((column) => ({ name: column.name, type: column.type })),
        rows,
        rowCount: rows.length,
        truncated,
        command: "SELECT",
        durationMs: Date.now() - started,
      };
    },
    async execute(sql) {
      const response = await requestWithRestart("UPDATE", { connId, sql });
      if (!response.ok) throw fail(response, "JDBC statement failed");
      return { rowCount: Number(response.fields?.rows || 0) };
    },
    async tables() {
      const response = await requestWithRestart("METATABLES", { connId });
      if (!response.ok) throw fail(response, "JDBC metadata failed");
      return (response.rows || []).map((row) => ({
        schema: row[0] || "",
        name: row[1] || "",
        type: row[2] === "view" ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      const response = await requestWithRestart("METACOLUMNS", { connId, schema, table });
      if (!response.ok) throw fail(response, "JDBC metadata failed");
      return (response.rows || []).map((row) => ({
        name: row[0] || "",
        type: row[1] || "",
        nullable: row[2] === "true",
        primaryKey: row[3] === "true",
      }));
    },
    async control(action) {
      await ensure();
      const method = action === "begin" ? "BEGIN" : action === "commit" ? "COMMIT" : "ROLLBACK";
      const response = await sidecar.request(method, { connId });
      if (!response.ok) throw fail(response, "JDBC transaction failed");
      inTransaction = action === "begin";
    },
    /**
     * The sidecar executes one statement at a time on its only thread, so it
     * cannot read a cancel request while a statement runs. Killing the JVM is
     * the only way to stop it; the next call starts a fresh sidecar.
     */
    async cancel() {
      if (busy === 0) return;
      cancelEpoch += 1;
      connecting = null;
      sidecar.kill();
    },
    forceClose() {
      connecting = null;
      sidecar.kill();
    },
    async close() {
      try {
        if (connecting) await sidecar.request("DISCONNECT", { connId });
      } catch {
        // ignore
      }
      await sidecar.stop();
    },
  };
}


function createSqlServerSession(target) {
  const tedious = require("tedious");
  let connection = null;
  let connecting = null;
  let generation = 0;

  function connect() {
    return new Promise((resolve, reject) => {
      const config = {
        server: target.host,
        authentication: {
          type: "default",
          options: { userName: target.username, password: target.password },
        },
        options: {
          port: target.port || 1433,
          database: target.database || undefined,
          encrypt: target.sslMode !== "disable",
          trustServerCertificate: target.sslMode !== "verify-ca" && target.sslMode !== "verify-full",
          rowCollectionOnRequestCompletion: true,
          useColumnNames: false,
          connectTimeout: CONNECT_TIMEOUT_MS,
          requestTimeout: 0,
        },
      };
      const instance = new tedious.Connection(config);
      instance.on("connect", (error) => {
        if (error) {
          reject(normalizeError(error));
          return;
        }
        resolve(instance);
      });
      instance.on("error", () => {
        if (connection === instance) connection = null;
      });
      instance.on("end", () => {
        if (connection === instance) connection = null;
      });
      instance.connect();
    });
  }

  async function ensure() {
    if (connection) return connection;
    if (connecting) return connecting;
    connecting = connect().then((instance) => {
      connection = instance;
      generation += 1;
      return instance;
    });
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  function exec(instance, sql, maxRows) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const request = new tedious.Request(sql, (error, rowCount, rows) => {
        if (error) {
          reject(normalizeError(error));
          return;
        }
        const collected = rows || [];
        const columns = (collected[0] || []).map((cell) => ({
          name: cell.metadata.colName,
          type: cell.metadata.type?.name,
        }));
        const matrix = collected
          .slice(0, maxRows)
          .map((row) => row.map((cell) => toCellValue(cell.value)));
        resolve({
          columns,
          rows: matrix,
          rowCount: Number.isFinite(rowCount) ? rowCount : matrix.length,
          truncated: matrix.length < collected.length || (rowCount || 0) > matrix.length,
          command: /^\s*(select|show|with)/i.test(sql) ? "SELECT" : commandFromSql(sql),
          durationMs: Date.now() - started,
        });
      });
      instance.execSql(request);
    });
  }

  return {
    kind: "sqlserver",
    ensure,
    generation: () => generation,
    async serverVersion() {
      const instance = await ensure();
      const result = await exec(instance, "select @@version as version", 1);
      return String(result.rows?.[0]?.[0] || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      return exec(instance, sql, maxRows);
    },
    async tables() {
      const instance = await ensure();
      const result = await exec(
        instance,
        "select table_schema as [schema], table_name as [name], table_type as [type] " +
          "from information_schema.tables order by table_schema, table_name",
        SCHEMA_TABLE_LIMIT,
      );
      return result.rows.map((row) => ({
        schema: String(row[0] || ""),
        name: String(row[1] || ""),
        type: /view/i.test(String(row[2] || "")) ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const escapedSchema = String(schema || "dbo").replace(/'/g, "''");
      const escapedTable = String(table || "").replace(/'/g, "''");
      const result = await exec(
        instance,
        "select c.column_name as [name], c.data_type as [type], c.is_nullable as [nullable], " +
          "c.character_maximum_length as [size], c.numeric_precision as [precision], c.numeric_scale as [scale], " +
          "case when exists (" +
          "  select 1 from information_schema.table_constraints tc " +
          "  join information_schema.key_column_usage kcu " +
          "    on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema " +
          "  where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema " +
          "    and tc.table_name = c.table_name and kcu.column_name = c.column_name" +
          ") then 1 else 0 end as [is_pk] " +
          `from information_schema.columns c where c.table_schema = '${escapedSchema}' and c.table_name = '${escapedTable}' ` +
          "order by c.ordinal_position",
        HARD_MAX_ROWS,
      );
      return result.rows.map((row) => ({
        name: String(row[0] || ""),
        type: withTypeSize(row[1], row.size ?? row.precision, row.scale),
        nullable: String(row[2] || "").toUpperCase() === "YES",
        primaryKey: Number(row[6]) === 1,
      }));
    },
    async control() {
      throw Object.assign(new Error("Transactions are managed by SQL Server itself"), {
        code: "control-unsupported",
      });
    },
    async cancel() {
      // Sends a TDS attention: the running request fails with ECANCEL and the
      // session stays usable.
      try {
        connection?.cancel();
      } catch {
        // ignore
      }
    },
    forceClose() {
      const instance = connection;
      connection = null;
      try {
        instance?.close();
      } catch {
        // ignore
      }
    },
    async close() {
      if (connection) {
        try {
          connection.close();
        } catch {
          // ignore
        }
        connection = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function driverFor(kind) {
  switch (kind) {
    case "postgresql":
      return createPgSession;
    case "mysql":
    case "mariadb":
      return createMysqlSession;
    case "oracle":
      return createOracleSession;
    case "sqlserver":
      return createSqlServerSession;
    case "sqlite":
      return createSqliteSession;
    case "jdbc":
      return createJdbcSession;
    default: {
      const error = new Error(`Unsupported database kind: ${kind}`);
      error.code = "unsupported-kind";
      throw error;
    }
  }
}

function targetKey(target) {
  return target.id || [
    target.kind,
    target.host,
    target.port,
    target.database,
    target.username,
    target.sqlitePath,
  ].join("|");
}

/** Very small SQL splitter: enough for init scripts, not a full parser. */
function splitSqlStatements(script) {
  const statements = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "-" && script[index + 1] === "-") {
      const end = script.indexOf("\n", index);
      index = end === -1 ? script.length : end;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * One serialized session for a connection target. Not registered anywhere:
 * `getSession` caches entries for the workbench, `handlers.test` uses a
 * throwaway one so a test never touches (or closes) the live session.
 */
function createEntry(target, key = targetKey(target)) {
  const session = driverFor(target.kind)(target);
  let chain = Promise.resolve();
  let closePromise = null;
  const entry = {
    key,
    session,
    target,
    fingerprint: connectionFingerprint(target),
    closed: false,
    /** Transaction state as the bridge last saw it, tied to a connection generation. */
    transaction: { open: false, generation: 0 },
    /** The statement currently on the wire (for cancel). */
    activeRun: null,
    run(task) {
      const next = chain.then(task, task);
      // Keep the chain alive after failures so later queries still run.
      chain = next.catch(() => {});
      return next;
    },
    ready: Promise.resolve(),
    initError: null,
    close() {
      if (!closePromise) {
        entry.closed = true;
        if (sessions.get(key) === entry) sessions.delete(key);
        closePromise = closeSessionSafely(session);
      }
      return closePromise;
    },
  };
  if (typeof target.initSql === "string" && target.initSql.trim()) {
    entry.ready = entry
      .run(async () => {
        for (const statement of splitSqlStatements(target.initSql)) {
          // Bounded: every later query on this session waits for init.
          await runWithDeadline(
            entry,
            () => entry.session.query(statement, { maxRows: 1, timeoutMs: DEFAULT_TIMEOUT_MS }),
            DEFAULT_TIMEOUT_MS,
          );
        }
      })
      .catch((error) => {
        entry.initError = normalizeError(error);
      });
  }
  return entry;
}

function getSession(target) {
  const key = targetKey(target);
  let entry = sessions.get(key);
  if (entry && entry.fingerprint !== connectionFingerprint(target)) {
    // Edited host / password / charset / init SQL: the cached session dials
    // the old settings, so replace it rather than reuse it.
    void entry.close();
    entry = undefined;
  }
  if (!entry) {
    entry = createEntry(target, key);
    sessions.set(key, entry);
  }
  return entry;
}

function withTimeout(promise, ms, onTimeout) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        const pending = onTimeout?.();
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
      } catch {
        /* ignore */
      }
      const error = new Error(`Query timed out after ${ms} ms`);
      error.code = "query-timeout";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * A physical reconnect (dropped socket, killed sidecar, server restart)
 * silently ends an open transaction. Running the next statement on the new
 * connection would auto-commit what the user meant to roll back, so the
 * bridge refuses once and tells the UI the transaction is gone.
 */
async function assertTransactionIntact(entry) {
  if (!entry.transaction.open) return;
  await entry.session.ensure?.();
  const generation = entry.session.generation?.() ?? entry.transaction.generation;
  if (generation === entry.transaction.generation) return;
  entry.transaction = { open: false, generation };
  throw errorWithCode(
    "The connection was lost and the open transaction was rolled back by the server. Start a new transaction before running more statements.",
    "transaction-lost",
  );
}

/**
 * Runs `operation` against the entry's session with a deadline. A timeout
 * first asks the driver to cancel; when the driver does not wind down in
 * time the session is reset so the next call starts clean.
 */
async function runWithDeadline(entry, operation, timeoutMs, { cancelOnTimeout = true } = {}) {
  const run = { cancelled: false, timedOut: false };
  entry.activeRun = run;
  const pending = Promise.resolve().then(operation);
  try {
    return await withTimeout(pending, timeoutMs, () => {
      run.timedOut = true;
      return cancelOnTimeout ? entry.session.cancel?.() : undefined;
    });
  } catch (error) {
    if (run.timedOut || run.cancelled) {
      const settled = await settleWithin(pending, CANCEL_SETTLE_MS);
      if (!settled) await entry.close();
    }
    if (run.cancelled) throw errorWithCode("Query cancelled", "query-cancelled");
    throw error;
  } finally {
    if (entry.activeRun === run) entry.activeRun = null;
  }
}

function transactionState(entry) {
  return { transactionOpen: entry.transaction.open };
}

const handlers = {
  async test(target) {
    const started = Date.now();
    let entry;
    try {
      // Throwaway session: never the cached one the workbench is using.
      entry = createEntry(target, `test:${Date.now()}:${Math.random().toString(36).slice(2)}`);
    } catch (error) {
      return failure(error);
    }
    try {
      await withTimeout(entry.ready, CONNECT_ROUNDTRIP_TIMEOUT_MS);
      if (entry.initError) throw entry.initError;
      const serverVersion = await entry.run(() =>
        runWithDeadline(entry, () => entry.session.serverVersion(), CONNECT_ROUNDTRIP_TIMEOUT_MS, {
          cancelOnTimeout: false,
        }),
      );
      return { ok: true, durationMs: Date.now() - started, serverVersion };
    } catch (error) {
      if (error?.code === "query-timeout") {
        return failure(errorWithCode(`Connection timed out after ${CONNECT_ROUNDTRIP_TIMEOUT_MS / 1000}s`, "connect-timeout"));
      }
      return failure(error);
    } finally {
      await entry.close();
    }
  },

  async connect(target) {
    const started = Date.now();
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      await withTimeout(entry.ready, CONNECT_ROUNDTRIP_TIMEOUT_MS);
      if (entry.initError) throw entry.initError;
      const serverVersion = await entry.run(() =>
        runWithDeadline(entry, () => entry.session.serverVersion(), CONNECT_ROUNDTRIP_TIMEOUT_MS, {
          cancelOnTimeout: false,
        }),
      );
      return { ok: true, durationMs: Date.now() - started, serverVersion };
    } catch (error) {
      await entry.close();
      if (error?.code === "query-timeout") {
        return failure(errorWithCode(`Connection timed out after ${CONNECT_ROUNDTRIP_TIMEOUT_MS / 1000}s`, "connect-timeout"));
      }
      return failure(error);
    }
  },

  async query({ target, sql, maxRows, timeoutMs }) {
    if (!sql || typeof sql !== "string" || !sql.trim()) {
      return failure(new Error("Empty SQL statement"));
    }
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    const limit = clampMaxRows(maxRows);
    const timeout = clampTimeout(timeoutMs);
    // JDBC drivers enforce their own statement timeout first and keep the session.
    const deadline = target.kind === "jdbc" ? timeout + JDBC_TIMEOUT_GRACE_MS : timeout;
    try {
      await entry.ready;
      if (entry.initError) throw entry.initError;
      const result = await entry.run(async () => {
        await assertTransactionIntact(entry);
        const outcome = await runWithDeadline(
          entry,
          () => entry.session.query(sql, { maxRows: limit, timeoutMs: timeout }),
          deadline,
        );
        const effect = transactionEffectOf(target.kind, sql);
        if (effect) {
          entry.transaction = {
            open: effect === "begin",
            generation: entry.session.generation?.() ?? 0,
          };
        }
        return outcome;
      });
      return { ok: true, result, ...transactionState(entry) };
    } catch (error) {
      return { ...failure(error), ...transactionState(entry) };
    }
  },

  async tables({ target }) {
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      await entry.ready;
      if (entry.initError) throw entry.initError;
      const tables = await entry.run(() =>
        runWithDeadline(entry, () => entry.session.tables(), METADATA_TIMEOUT_MS),
      );
      return { ok: true, tables };
    } catch (error) {
      return failure(error);
    }
  },

  async columns({ target, schema, table }) {
    if (!table || typeof table !== "string") {
      return failure(new Error("Table name is required"));
    }
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      await entry.ready;
      if (entry.initError) throw entry.initError;
      const columns = await entry.run(() =>
        runWithDeadline(entry, () => entry.session.columns(schema, table), METADATA_TIMEOUT_MS),
      );
      return { ok: true, columns };
    } catch (error) {
      return failure(error);
    }
  },

  async control({ target, action }) {
    if (!["begin", "commit", "rollback"].includes(action)) {
      return failure(new Error(`Unsupported transaction action: ${action}`));
    }
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      await entry.ready;
      if (entry.initError) throw entry.initError;
      await entry.run(async () => {
        if (action !== "begin") await assertTransactionIntact(entry);
        await runWithDeadline(entry, () => entry.session.control(action), CONTROL_TIMEOUT_MS);
        entry.transaction = action === "begin"
          ? { open: true, generation: entry.session.generation?.() ?? 0 }
          : { open: false, generation: entry.session.generation?.() ?? 0 };
      });
      return { ok: true, action, ...transactionState(entry) };
    } catch (error) {
      return { ...failure(error), ...transactionState(entry) };
    }
  },

  async cancel({ id }) {
    const entry = sessions.get(id);
    if (!entry) return { ok: true, cancelled: false };
    const run = entry.activeRun;
    if (run) run.cancelled = true;
    try {
      await settleWithin(Promise.resolve(entry.session.cancel?.()), CANCEL_SETTLE_MS);
    } catch {
      /* ignore */
    }
    return { ok: true, cancelled: Boolean(run) };
  },

  async disconnect({ id }) {
    const entry = sessions.get(id);
    if (!entry) return { ok: true };
    await entry.close();
    return { ok: true };
  },

  async dispose() {
    const entries = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(entries.map((entry) => entry.close()));
    return { ok: true };
  },
};

const MAX_SQL_FILE_BYTES = 5 * 1024 * 1024;

/** Reports the Java runtime the JDBC sidecar would use, for the editor hint. */
function javaRuntimeInfo(payload) {
  return resolveJava({ javaPath: payload?.javaPath, javaHome: payload?.javaHome });
}

/** Lists the JDBC driver classes declared by a driver jar. */
function driverClassesFromJar(payload) {
  const jarPath = payload?.jarPath;
  if (typeof jarPath !== "string" || !jarPath) return { ok: true, classes: [] };
  try {
    return { ok: true, classes: readDriverClassesFromJar(jarPath) };
  } catch (error) {
    return { ok: false, classes: [], error: { message: error?.message || String(error) } };
  }
}

/** Reads a .sql script picked by the renderer; bounded so a huge file can't block. */
/**
 * Files the user picked in a native dialog during this run. Only these may be
 * overwritten without asking again ("Save" after "Open" / "Save as"); any
 * other path sent by the renderer goes back through the save dialog.
 */
const approvedTextFilePaths = new Set();
const MAX_APPROVED_TEXT_FILE_PATHS = 200;

function approveTextFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath) return;
  const resolved = path.resolve(filePath);
  approvedTextFilePaths.delete(resolved);
  approvedTextFilePaths.add(resolved);
  if (approvedTextFilePaths.size > MAX_APPROVED_TEXT_FILE_PATHS) {
    approvedTextFilePaths.delete(approvedTextFilePaths.values().next().value);
  }
}

function isApprovedTextFilePath(filePath) {
  return typeof filePath === "string" && filePath !== "" && approvedTextFilePaths.has(path.resolve(filePath));
}

function sanitizeDialogFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  const clean = filters
    .filter((entry) => entry && typeof entry.name === "string" && Array.isArray(entry.extensions))
    .map((entry) => ({
      name: entry.name.slice(0, 60),
      extensions: entry.extensions.filter((ext) => typeof ext === "string" && /^[\w*]{1,12}$/.test(ext)),
    }))
    .filter((entry) => entry.extensions.length > 0);
  return clean.length > 0 ? clean : undefined;
}

async function readSqlFile(rawPath) {
  const filePath = typeof rawPath === "string" ? rawPath : rawPath?.path;
  if (!filePath) return { ok: false, error: "missing-path" };
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: "not-a-file" };
    if (stat.size > MAX_SQL_FILE_BYTES) return { ok: false, error: "too-large" };
    const text = await fs.promises.readFile(filePath, "utf8");
    approveTextFilePath(filePath);
    return { ok: true, text, path: filePath };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "read-failed" };
  }
}

const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Saves a text file the renderer produced (SQL scripts, exports, DDL dumps).
 *
 * `path` overwrites that file directly, but only when the user already picked
 * it in a dialog during this run; otherwise (and for "save as") the native
 * save dialog opens, pre-filled with `path` or `defaultName`.
 */
async function saveTextFile(payload) {
  const { defaultName, content, filters } = payload || {};
  const targetPath = typeof payload?.path === "string" ? payload.path : "";
  if (typeof content !== "string") return { ok: false, error: "nothing-to-save" };
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
    return { ok: false, error: "too-large" };
  }
  try {
    if (targetPath && isApprovedTextFilePath(targetPath)) {
      const resolved = path.resolve(targetPath);
      await fs.promises.writeFile(resolved, content, "utf8");
      return { ok: true, path: resolved };
    }
    const { dialog } = require("electron");
    const result = await dialog.showSaveDialog({
      defaultPath: targetPath || (typeof defaultName === "string" ? defaultName : undefined),
      filters: sanitizeDialogFilters(filters),
    });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(result.filePath, content, "utf8");
    approveTextFilePath(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || "write-failed" };
  }
}

/**
 * Saves a binary export (xlsx and friends). The renderer hands over base64
 * because IPC serialises strings, and main converts it back to bytes.
 */
async function saveBinaryFile(payload) {
  const { defaultName, base64 } = payload || {};
  if (typeof base64 !== "string" || base64.length === 0) {
    return { ok: false, error: "nothing-to-save" };
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength > MAX_BINARY_FILE_BYTES) {
    return { ok: false, error: "too-large" };
  }
  try {
    const { dialog } = require("electron");
    const result = await dialog.showSaveDialog({
      defaultPath: typeof defaultName === "string" ? defaultName : undefined,
    });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(result.filePath, buffer);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || "write-failed" };
  }
}

function registerDbHandlers(ipcMain) {
  ipcMain.handle("netcatty:db:test", (_event, target) => handlers.test(target));
  ipcMain.handle("netcatty:db:connect", (_event, target) => handlers.connect(target));
  ipcMain.handle("netcatty:db:query", (_event, payload) => handlers.query(payload || {}));
  ipcMain.handle("netcatty:db:control", (_event, payload) => handlers.control(payload || {}));
  ipcMain.handle("netcatty:db:tables", (_event, payload) => handlers.tables(payload || {}));
  ipcMain.handle("netcatty:db:columns", (_event, payload) => handlers.columns(payload || {}));
  ipcMain.handle("netcatty:db:cancel", (_event, payload) => handlers.cancel(payload || {}));
  ipcMain.handle("netcatty:db:disconnect", (_event, payload) => handlers.disconnect(payload || {}));
  ipcMain.handle("netcatty:db:dispose", () => handlers.dispose());
  ipcMain.handle("netcatty:db:read-sql-file", (_event, payload) => readSqlFile(payload));
  ipcMain.handle("netcatty:db:save-text-file", (_event, payload) => saveTextFile(payload));
  ipcMain.handle("netcatty:db:save-binary-file", (_event, payload) => saveBinaryFile(payload));
  ipcMain.handle("netcatty:db:driver-classes", (_event, payload) => driverClassesFromJar(payload));
  ipcMain.handle("netcatty:db:java-runtime", (_event, payload) => javaRuntimeInfo(payload));
}

module.exports = {
  registerDbHandlers,
  handlers,
  readSqlFile,
  saveTextFile,
  saveBinaryFile,
  __test: {
    clampMaxRows,
    clampTimeout,
    toCellValue,
    normalizeError,
    pgSslOptions,
    mysqlSslOptions,
    rowsToMatrix,
    numberOrUndefined,
    shapeMysqlResult,
    mysqlTypeName,
    commandFromSql,
    sessions,
    connectionFingerprint,
    transactionEffectOf,
    settleWithin,
    resolvesWithin,
    withTimeout,
    createEntry,
    getSession,
  },
};
