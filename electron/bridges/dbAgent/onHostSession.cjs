"use strict";

/**
 * Database session that runs on an SSH host.
 *
 * Instead of dialing the database from this machine, Netcatty starts a small
 * agent in a login shell on the host and lets it use the database client
 * libraries installed there (DSCI, or the ProMDB / DMDB client). Nothing but
 * SSH has to be reachable: no database port, no port forwarding.
 *
 * The renderer opens the shell through the port-forwarding bridge, which
 * hands it over as a loopback port guarded by a one-time token. This module
 * connects to that port, brings the agent up (agentLink.cjs) and maps the
 * workbench's operations onto agent requests.
 */

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { AgentLink } = require("./agentLink.cjs");
const { deriveSelectColumns, parseDescribeOutput, quoteLiteral } = require("./sqlShape.cjs");

const RELAY_CONNECT_TIMEOUT_MS = 10000;
/**
 * The workbench's liveness check for this driver (ON_HOST_PING_SQL in
 * domain/database/probe.ts). It is answered by the agent instead of the
 * database: no single probe statement is valid for every engine behind the
 * host's client libraries.
 */
const PING_SQL = "/* netcatty:ping */";
const KEEPALIVE_MS = 45000;
const CANCEL_WAIT_MS = 2500;
const CLOSE_WAIT_MS = 1500;
const METADATA_ROWS = 100000;

let cachedAgentSource = null;

function loadAgentSource() {
  if (!cachedAgentSource) {
    cachedAgentSource = fs.readFileSync(path.join(__dirname, "agent", "netcatty_dbagent.py"));
  }
  return cachedAgentSource;
}

function sessionError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

/** Connects to the relay port and presents its token. */
function connectRelay(target) {
  const settings = target.onHost ?? {};
  const port = Number(target.port);
  if (!Number.isInteger(port) || port <= 0 || !settings.relayToken) {
    return Promise.reject(sessionError(
      "onhost-relay",
      "This connection runs on an SSH host, but no session to that host was opened for it",
    ));
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host || "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(sessionError("onhost-relay", "Timed out reaching the session to the SSH host"));
    }, RELAY_CONNECT_TIMEOUT_MS);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(sessionError("onhost-relay", `Cannot reach the session to the SSH host: ${error.message}`));
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.write(`${settings.relayToken}\n`);
      resolve(socket);
    });
  });
}

function sanitizeLoginSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step) => step && (typeof step.expect === "string" || typeof step.send === "string"))
    .map((step) => ({
      expect: typeof step.expect === "string" ? step.expect : "",
      send: typeof step.send === "string" ? step.send : "",
      ...(Number(step.timeoutMs) > 0 ? { timeoutMs: Number(step.timeoutMs) } : {}),
    }));
}

function openParams(target) {
  const settings = target.onHost ?? {};
  return {
    mode: settings.mode === "direct" ? "direct" : "config",
    backend: settings.backend || "auto",
    dbType: settings.dbType || "",
    server: settings.server || "",
    dbNo: Number(settings.dbNo) || 0,
    user: target.username || "",
    password: target.password || "",
    encoding: target.clientEncoding || "auto",
  };
}

function describeTarget(info) {
  const parts = [];
  if (info.clientVersion) parts.push(info.clientVersion);
  if (info.target) parts.push(info.target);
  if (info.backend) parts.push(`via ${info.backend}`);
  return parts.join(" · ") || "On-host driver";
}

function createOnHostSession(target, deps = {}) {
  const connect = deps.connect ?? connectRelay;
  const commandFromSql = deps.commandFromSql ?? ((sql) => String(sql).trim().split(/\s+/)[0]?.toUpperCase() || "OK");
  const settings = target.onHost ?? {};

  let link = null;
  let info = null;
  let connecting = null;
  let generation = 0;
  let keepalive = null;
  /** The link that is being brought up: logging in, starting the agent. */
  let opening = null;
  /** Bumped by every close, so a login that was under way knows it is unwanted. */
  let closes = 0;
  const columnCache = new Map();

  const stopKeepalive = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
  };

  const closedWhileOpening = () => sessionError("agent-exit", "The connection was closed while it was being opened");

  const open = async () => {
    const startedAt = closes;
    const stream = await connect(target);
    if (closes !== startedAt) {
      stream.destroy();
      throw closedWhileOpening();
    }
    const next = new AgentLink(stream, {
      agentSource: deps.agentSource ?? loadAgentSource(),
      loginSteps: sanitizeLoginSteps(settings.loginSteps),
      envCommand: settings.envCommand,
      python: settings.python,
      timeouts: deps.timeouts,
    });
    opening = next;
    let opened;
    try {
      await next.start();
      try {
        opened = await next.request("OPEN", openParams(target));
      } catch (error) {
        if (error.code === "library-missing" || error.code === "connect-failed") {
          // Say what the host looks like: which libraries load, which do not.
          try {
            const diag = await next.request("DIAG", {});
            error.detail = summarizeDiagnostics(diag);
          } catch {
            /* the first error is the one that matters */
          }
        }
        next.close();
        throw error;
      }
    } finally {
      if (opening === next) opening = null;
    }
    if (closes !== startedAt) {
      // Closed between the agent's answer and here: nobody owns this shell.
      next.close();
      throw closedWhileOpening();
    }
    link = next;
    info = opened;
    generation += 1;
    columnCache.clear();
    next.once("close", () => {
      if (link !== next) return;
      link = null;
      connecting = null;
      stopKeepalive();
    });
    stopKeepalive();
    // Bastions and idle policies end sessions that say nothing for a while.
    keepalive = setInterval(() => {
      if (link === next && !next.busy) next.request("PING", {}).catch(() => {});
    }, deps.keepaliveMs ?? KEEPALIVE_MS);
    keepalive.unref?.();
    return opened;
  };

  /**
   * Ends a login that is still under way. Without this a session closed while
   * it was connecting (a timeout, a tab closed early) would leave its shell on
   * the host, logged in and unused, for as long as the SSH session lasts.
   */
  const abandonOpening = () => {
    closes += 1;
    connecting = null;
    const pending = opening;
    opening = null;
    pending?.close(closedWhileOpening());
  };

  const ensure = () => {
    if (!connecting) {
      const pending = open();
      connecting = pending;
      pending.catch(() => {
        if (connecting === pending) connecting = null;
      });
    }
    return connecting;
  };

  /** Runs a statement and collects its rows. */
  const run = async (sql, maxRows, timeoutMs) => {
    await ensure();
    const active = link;
    if (!active) throw sessionError("agent-exit", "The session to the host ended");
    const columns = [];
    const rows = [];
    const result = await active.request(
      "QUERY",
      { sql, maxRows, timeoutMs: timeoutMs || 0 },
      {
        onColumns: (list) => columns.push(...list),
        onRows: (batch) => {
          for (const row of batch) rows.push(row);
        },
      },
    );
    return { result, columns, rows };
  };

  const family = () => info?.family ?? "unknown";

  const describeMdbTable = async (schema, table) => {
    const qualified = schema ? `${schema}.${table}` : table;
    if (info?.anyStatement) {
      try {
        const described = await run(`desc ${qualified}`, METADATA_ROWS, 0);
        const lines = described.rows.flatMap((row) => String(row[0] ?? "").split(/\r?\n/));
        const parsed = parseDescribeOutput(lines);
        if (parsed.length > 0) return parsed;
      } catch {
        /* fall through to an empty select */
      }
    }
    const empty = await run(`select * from ${qualified} where 1=2`, 1, 0);
    if (empty.columns.some((column) => !column.name)) return [];
    return empty.columns.map((column) => ({
      name: column.name,
      type: column.type || "",
      nullable: true,
      primaryKey: false,
    }));
  };

  const listColumns = async (schema, table) => {
    const key = `${schema || ""}.${table}`.toUpperCase();
    if (columnCache.has(key)) return columnCache.get(key);
    let columns;
    switch (family()) {
      case "mdb":
        columns = await describeMdbTable(schema, table);
        break;
      case "mysql": {
        const scope = schema ? `table_schema = ${quoteLiteral(schema)}` : "table_schema = database()";
        const listed = await run(
          `select column_name, column_type, is_nullable, column_key from information_schema.columns where ${scope} and table_name = ${quoteLiteral(table)} order by ordinal_position`,
          METADATA_ROWS,
          0,
        );
        columns = listed.rows.map((row) => ({
          name: String(row[0] ?? ""),
          type: String(row[1] ?? ""),
          nullable: String(row[2] ?? "").toUpperCase() !== "NO",
          primaryKey: String(row[3] ?? "").toUpperCase() === "PRI",
        }));
        break;
      }
      case "oracle": {
        const owner = schema ? `owner = ${quoteLiteral(schema.toUpperCase())} and ` : "";
        const listed = await run(
          `select column_name, data_type, nullable from all_tab_columns where ${owner}table_name = ${quoteLiteral(table.toUpperCase())} order by column_id`,
          METADATA_ROWS,
          0,
        );
        columns = listed.rows.map((row) => ({
          name: String(row[0] ?? ""),
          type: String(row[1] ?? ""),
          nullable: String(row[2] ?? "").toUpperCase() !== "N",
          primaryKey: false,
        }));
        break;
      }
      case "opengauss": {
        const scope = schema ? `table_schema = ${quoteLiteral(schema)} and ` : "";
        const listed = await run(
          `select column_name, data_type, is_nullable from information_schema.columns where ${scope}table_name = ${quoteLiteral(table)} order by ordinal_position`,
          METADATA_ROWS,
          0,
        );
        columns = listed.rows.map((row) => ({
          name: String(row[0] ?? ""),
          type: String(row[1] ?? ""),
          nullable: String(row[2] ?? "").toUpperCase() !== "NO",
          primaryKey: false,
        }));
        break;
      }
      default:
        columns = [];
    }
    if (columns.length > 0) columnCache.set(key, columns);
    return columns;
  };

  /** Names for a result whose library reported none. */
  const nameColumns = async (sql, columns) => {
    if (columns.every((column) => column.name)) return columns;
    const fallback = columns.map((column, index) => ({ name: `COL${index + 1}`, type: column.type || "" }));
    const derived = deriveSelectColumns(sql);
    if (!derived) return fallback;
    if (derived.names) {
      return derived.names.length === columns.length
        ? derived.names.map((name, index) => ({ name, type: columns[index].type || "" }))
        : fallback;
    }
    try {
      const parts = derived.starTable.split(".");
      const table = parts.pop();
      const known = await listColumns(parts.join(".") || "", table);
      if (known.length === columns.length) {
        return known.map((column, index) => ({ name: column.name, type: column.type || columns[index].type || "" }));
      }
    } catch {
      /* names are a convenience; the rows are what was asked for */
    }
    return fallback;
  };

  const listTables = async () => {
    switch (family()) {
      case "mdb": {
        let listed;
        try {
          listed = await run(
            "select user_name, table_name, table_space from dba_tables order by user_name, table_name",
            METADATA_ROWS,
            0,
          );
        } catch (error) {
          if (error.code !== "db-error") throw error;
          listed = await run("select user_name, table_name from dba_tables order by user_name, table_name", METADATA_ROWS, 0);
        }
        return listed.rows
          .filter((row) => String(row[2] ?? "").toUpperCase() !== "SEQ")
          .map((row) => ({
            schema: String(row[0] ?? ""),
            name: String(row[1] ?? ""),
            type: String(row[2] ?? "").toUpperCase() === "VIEW" ? "view" : "table",
          }));
      }
      case "mysql": {
        const listed = await run(
          "select table_schema, table_name, table_type from information_schema.tables where table_schema = database() order by table_name",
          METADATA_ROWS,
          0,
        );
        return listed.rows.map((row) => ({
          schema: String(row[0] ?? ""),
          name: String(row[1] ?? ""),
          type: /view/i.test(String(row[2] ?? "")) ? "view" : "table",
        }));
      }
      case "oracle": {
        const listed = await run(
          "select owner, table_name from all_tables where owner not in ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','WMSYS','OUTLN','DBSNMP') order by owner, table_name",
          METADATA_ROWS,
          0,
        );
        return listed.rows.map((row) => ({ schema: String(row[0] ?? ""), name: String(row[1] ?? ""), type: "table" }));
      }
      case "opengauss": {
        const listed = await run(
          "select table_schema, table_name, table_type from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by table_schema, table_name",
          METADATA_ROWS,
          0,
        );
        return listed.rows.map((row) => ({
          schema: String(row[0] ?? ""),
          name: String(row[1] ?? ""),
          type: /view/i.test(String(row[2] ?? "")) ? "view" : "table",
        }));
      }
      default:
        return [];
    }
  };

  return {
    kind: "onhost",
    ensure,
    generation: () => generation,
    async serverVersion() {
      return describeTarget(await ensure());
    },
    async query(sql, { maxRows, timeoutMs }) {
      const started = Date.now();
      if (String(sql).trim() === PING_SQL) {
        await ensure();
        const active = link;
        if (!active) throw sessionError("agent-exit", "The session to the host ended");
        await active.request("PING", {});
        return { columns: [], rows: [], rowCount: 0, truncated: false, command: "PING", durationMs: Date.now() - started };
      }
      const { result, columns, rows } = await run(sql, maxRows, timeoutMs);
      if (!result.select) {
        return {
          columns: [],
          rows: [],
          rowCount: Number(result.affected ?? 0),
          truncated: false,
          command: result.command || commandFromSql(sql),
          durationMs: Date.now() - started,
        };
      }
      const named = await nameColumns(sql, columns);
      return {
        columns: named.map((column) => ({ name: column.name, type: column.type || undefined })),
        rows,
        rowCount: rows.length,
        truncated: result.truncated === true,
        command: "SELECT",
        durationMs: Date.now() - started,
      };
    },
    async execute(sql) {
      const { result } = await run(sql, 1, 0);
      return { rowCount: Number(result.affected ?? 0) };
    },
    tables: listTables,
    columns: listColumns,
    async control(action) {
      await ensure();
      const active = link;
      if (!active) throw sessionError("agent-exit", "The session to the host ended");
      await active.request(action === "begin" ? "BEGIN" : action === "commit" ? "COMMIT" : "ROLLBACK", {});
    },
    /**
     * The agent stops a result set that is being read; a statement the server
     * is still working on can only be stopped by ending the agent, which the
     * agent does itself. Either way the session is dropped if the statement
     * is still pending shortly after.
     */
    async cancel() {
      const active = link;
      if (!active || !active.busy) return;
      active.request("CANCEL", {}).catch(() => {});
      const deadline = Date.now() + CANCEL_WAIT_MS;
      while (!active.closed && active.busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!active.closed && active.busy) {
        active.close(sessionError("query-cancelled", "Query cancelled"));
      }
    },
    forceClose() {
      stopKeepalive();
      abandonOpening();
      link?.close();
    },
    async close() {
      stopKeepalive();
      const active = link;
      abandonOpening();
      if (!active || active.closed) return;
      await Promise.race([
        active.request("CLOSE", {}).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS)),
      ]);
      active.close();
    },
  };
}

/** A few lines about the host's libraries, for a failed connection. */
function summarizeDiagnostics(diag) {
  const lines = [];
  if (diag.python) lines.push(`Python ${diag.python}`);
  const env = diag.env ?? {};
  for (const name of ["DSCI_PATH", "DCI_HOME", "LD_LIBRARY_PATH"]) {
    lines.push(`${name}=${env[name] ?? "(not set)"}`);
  }
  for (const library of diag.libraries ?? []) {
    lines.push(library.ok ? `${library.name}: loaded${library.path ? ` (${library.path})` : ""}` : `${library.name}: ${library.error}`);
  }
  const config = diag.dsciConfig;
  if (config) {
    lines.push(config.exists
      ? `${config.path}: ${config.dbs.map((db) => `${db.name}=${db.type}`).join(", ") || "no databases"}; default ${config.default ?? "?"}`
      : `${config.path}: missing`);
  }
  return lines.join("\n");
}

module.exports = {
  PING_SQL,
  createOnHostSession,
  connectRelay,
  loadAgentSource,
  sanitizeLoginSteps,
  summarizeDiagnostics,
};
