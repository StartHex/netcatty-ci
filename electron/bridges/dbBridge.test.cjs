"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const bridge = require("./dbBridge.cjs");
const { __test, handlers } = bridge;

const {
  shapeMysqlResult,
  commandFromSql,
  clampMaxRows,
  clampTimeout,
  toCellValue,
  normalizeError,
  pgSslOptions,
  mysqlSslOptions,
  rowsToMatrix,
} = __test;

test("clampMaxRows applies the default and hard ceiling", () => {
  assert.equal(clampMaxRows(undefined), 1000);
  assert.equal(clampMaxRows(0), 1000);
  assert.equal(clampMaxRows(50), 50);
  assert.equal(clampMaxRows(999999), 5000);
  assert.equal(clampMaxRows("25"), 25);
});

test("clampTimeout keeps timeouts inside the allowed window", () => {
  assert.equal(clampTimeout(undefined), 30000);
  assert.equal(clampTimeout(1), 1);
  assert.equal(clampTimeout(900000), 600000);
});

test("toCellValue normalizes driver values for the renderer", () => {
  assert.equal(toCellValue(null), null);
  assert.equal(toCellValue(undefined), null);
  assert.equal(toCellValue(42), 42);
  assert.equal(toCellValue(true), true);
  const date = new Date("2026-01-02T03:04:05.000Z");
  assert.equal(toCellValue(date), date.toISOString());
  assert.equal(toCellValue(Buffer.from("hi")), "aGk=");
  assert.equal(toCellValue(10n), 10);
  assert.equal(toCellValue({ a: 1 }), '{"a":1}');
});

test("normalizeError keeps driver error metadata", () => {
  const error = Object.assign(new Error("relation does not exist"), {
    code: "42P01",
    sqlState: "42P01",
    position: "15",
    detail: "detail text",
    hint: "hint text",
  });
  const normalized = normalizeError(error);
  assert.equal(normalized.message, "relation does not exist");
  assert.equal(normalized.code, "42P01");
  assert.equal(normalized.sqlState, "42P01");
  assert.equal(normalized.position, "15");
  assert.equal(normalized.detail, "detail text");
  assert.equal(normalized.hint, "hint text");
  assert.equal(normalizeError(null).message, "Unknown database error");
});

test("rowsToMatrix aligns values with the requested column order", () => {
  const rows = [
    { b: 2, a: 1 },
    { a: 3 },
  ];
  assert.deepEqual(rowsToMatrix(rows, ["a", "b"]), [
    [1, 2],
    [3, null],
  ]);
});

test("SSL option builders map modes to driver settings", () => {
  assert.equal(pgSslOptions("disable"), false);
  assert.deepEqual(pgSslOptions("require"), { rejectUnauthorized: false });
  assert.deepEqual(pgSslOptions("verify-full"), { rejectUnauthorized: true });
  assert.equal(mysqlSslOptions("disable"), undefined);
  assert.deepEqual(mysqlSslOptions("require"), { rejectUnauthorized: false });
});

test("sqlite: connect, create, insert and query keep the session alive", async () => {
  const target = { id: "sqlite-memory-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    const connected = await handlers.connect(target);
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.match(String(connected.serverVersion), /^\d+\./);

    const created = await handlers.query({ target, sql: "create table people (id integer primary key, name text)" });
    assert.equal(created.ok, true, JSON.stringify(created));

    const inserted = await handlers.query({
      target,
      sql: "insert into people (name) values ('Ada'), ('Linus')",
    });
    assert.equal(inserted.ok, true, JSON.stringify(inserted));

    const selected = await handlers.query({ target, sql: "select id, name from people order by id" });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    assert.deepEqual(
      selected.result.columns.map((column) => column.name),
      ["id", "name"],
    );
    assert.deepEqual(selected.result.rows, [
      [1, "Ada"],
      [2, "Linus"],
    ]);
    assert.equal(selected.result.rowCount, 2);
    assert.equal(selected.result.truncated, false);
  } finally {
    await handlers.disconnect({ id: "sqlite-memory-test", kind: "sqlite", sqlitePath: ":memory:" });
  }
});

test("sqlite: maxRows marks the result truncated", async () => {
  const target = { id: "sqlite-limit-test", kind: "sqlite" };
  try {
    await handlers.query({ target, sql: "create table numbers (n integer)" });
    await handlers.query({ target, sql: "insert into numbers (n) values (1), (2), (3)" });
    const limited = await handlers.query({ target, sql: "select n from numbers", maxRows: 2 });
    assert.equal(limited.ok, true, JSON.stringify(limited));
    assert.equal(limited.result.rows.length, 2);
    assert.equal(limited.result.truncated, true);
  } finally {
    await handlers.disconnect({ id: "sqlite-limit-test", kind: "sqlite" });
  }
});

test("sqlite: unknown table reports a structured error", async () => {
  const target = { id: "sqlite-error-test", kind: "sqlite" };
  try {
    const failed = await handlers.query({ target, sql: "select * from missing_table" });
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /no such table/i);
  } finally {
    await handlers.disconnect({ id: "sqlite-error-test", kind: "sqlite" });
  }
});

test("unknown database kind fails with a clear error", async () => {
  const failed = await handlers.test({ id: "unknown", kind: "duckdb" });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /unsupported database kind/i);
});

test("sqlite: transaction control commits and rolls back", async () => {
  const target = { id: "sqlite-tx-test", kind: "sqlite" };
  try {
    await handlers.query({ target, sql: "create table tx (n integer)" });
    const begun = await handlers.control({ target, action: "begin" });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    await handlers.query({ target, sql: "insert into tx values (1)" });
    const rolled = await handlers.control({ target, action: "rollback" });
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    const afterRollback = await handlers.query({ target, sql: "select count(*) as c from tx" });
    assert.equal(afterRollback.result.rows[0][0], 0);

    await handlers.control({ target, action: "begin" });
    await handlers.query({ target, sql: "insert into tx values (2)" });
    await handlers.control({ target, action: "commit" });
    const afterCommit = await handlers.query({ target, sql: "select count(*) as c from tx" });
    assert.equal(afterCommit.result.rows[0][0], 1);
  } finally {
    await handlers.disconnect({ id: "sqlite-tx-test", kind: "sqlite" });
  }
});

test("transaction control rejects unknown actions", async () => {
  const failed = await handlers.control({
    target: { id: "sqlite-tx-invalid", kind: "sqlite" },
    action: "explode",
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /unsupported transaction action/i);
});

test("sqlite: lists tables and columns for the schema tree", async () => {
  const target = { id: "sqlite-schema-test", kind: "sqlite" };
  try {
    await handlers.query({
      target,
      sql: "create table people (id integer primary key, name text not null)",
    });
    const tables = await handlers.tables({ target });
    assert.equal(tables.ok, true, JSON.stringify(tables));
    const people = tables.tables.find((entry) => entry.name === "people");
    assert.ok(people, JSON.stringify(tables.tables));
    assert.equal(people.type, "table");
    assert.equal(people.schema, "main");

    const columns = await handlers.columns({ target, schema: "main", table: "people" });
    assert.equal(columns.ok, true, JSON.stringify(columns));
    assert.deepEqual(
      columns.columns.map((entry) => entry.name),
      ["id", "name"],
    );
    assert.equal(columns.columns[1].nullable, false);
    assert.equal(columns.columns[0].primaryKey, true);
    assert.equal(columns.columns[1].primaryKey, false);
  } finally {
    await handlers.disconnect({ id: "sqlite-schema-test", kind: "sqlite" });
  }
});

test("columns rejects a missing table name", async () => {
  const failed = await handlers.columns({ target: { id: "x", kind: "sqlite" }, table: "" });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /table name is required/i);
});

test("jdbc: reports a clear error when Java is missing", async () => {
  const target = {
    id: "jdbc-no-java",
    kind: "jdbc",
    jdbcUrl: "jdbc:h2:mem:nope",
    jdbcDriverPaths: [],
    javaPath: "/nonexistent/bin/java",
  };
  const result = await handlers.connect(target);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Java|java|sidecar/i);
  await handlers.disconnect({ id: "jdbc-no-java", kind: "jdbc" });
});

test("initSql runs once before the first query", async () => {
  const target = {
    id: "sqlite-init",
    kind: "sqlite",
    sqlitePath: ":memory:",
    initSql: "create table init_probe(value integer);\ninsert into init_probe values (7);",
  };
  const connected = await handlers.connect(target);
  assert.equal(connected.ok, true);
  const result = await handlers.query({ target, sql: "select value from init_probe" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.rows, [[7]]);
  await handlers.disconnect({ id: "sqlite-init", kind: "sqlite" });
});

test("a failing initSql surfaces on connect", async () => {
  const target = {
    id: "sqlite-init-bad",
    kind: "sqlite",
    sqlitePath: ":memory:",
    initSql: "create table broken(",
  };
  const connected = await handlers.connect(target);
  assert.equal(connected.ok, false);
  assert.ok(connected.error.message);
  await handlers.disconnect({ id: "sqlite-init-bad", kind: "sqlite" });
});

test("readSqlFile reads utf8 scripts and rejects missing paths", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const file = path.join(os.tmpdir(), `netcatty-sql-${Date.now()}.sql`);
  fs.writeFileSync(file, "select 1;\nselect '中文';", "utf8");
  const ok = await bridge.readSqlFile(file);
  assert.equal(ok.ok, true);
  assert.match(ok.text, /select 1/);
  const missing = await bridge.readSqlFile(path.join(os.tmpdir(), "does-not-exist.sql"));
  assert.equal(missing.ok, false);
  fs.unlinkSync(file);
});

test("saveTextFile overwrites only files the user picked in a dialog", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const Module = require("node:module");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sql-save-"));
  const opened = path.join(dir, "opened.sql");
  const foreign = path.join(dir, "foreign.sql");
  const picked = path.join(dir, "picked.sql");
  fs.writeFileSync(opened, "select 1;", "utf8");
  fs.writeFileSync(foreign, "keep me", "utf8");

  // Stand-in for electron's dialog: records the options, "picks" picked.sql.
  const dialogCalls = [];
  const originalLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === "electron") {
      return {
        dialog: {
          showSaveDialog: async (options) => {
            dialogCalls.push(options);
            return { canceled: false, filePath: picked };
          },
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    // Opened through readSqlFile -> direct overwrite, no dialog.
    assert.equal((await bridge.readSqlFile(opened)).ok, true);
    const direct = await bridge.saveTextFile({ path: opened, content: "select 2;" });
    assert.deepEqual(direct, { ok: true, path: opened });
    assert.equal(fs.readFileSync(opened, "utf8"), "select 2;");
    assert.equal(dialogCalls.length, 0);

    // A path the user never picked is not written: the dialog decides.
    const redirected = await bridge.saveTextFile({
      path: foreign,
      content: "select 3;",
      filters: [{ name: "SQL", extensions: ["sql"] }, { name: "bad", extensions: ["../x"] }],
    });
    assert.deepEqual(redirected, { ok: true, path: picked });
    assert.equal(fs.readFileSync(foreign, "utf8"), "keep me");
    assert.equal(fs.readFileSync(picked, "utf8"), "select 3;");
    assert.equal(dialogCalls.length, 1);
    assert.equal(dialogCalls[0].defaultPath, foreign);
    assert.deepEqual(dialogCalls[0].filters, [{ name: "SQL", extensions: ["sql"] }]);

    // The file picked in the dialog is approved from then on.
    const again = await bridge.saveTextFile({ path: picked, content: "select 4;" });
    assert.deepEqual(again, { ok: true, path: picked });
    assert.equal(dialogCalls.length, 1);
    assert.equal(fs.readFileSync(picked, "utf8"), "select 4;");
  } finally {
    Module._load = originalLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mysql: single SELECT rows are returned as a grid", () => {
  const fields = [{ name: "ok", type: 8 }];
  const result = shapeMysqlResult([{ ok: 1 }], fields, 100, Date.now());
  assert.equal(result.command, "SELECT");
  assert.deepEqual(result.columns.map((column) => column.name), ["ok"]);
  assert.deepEqual(result.rows, [[1]]);
  assert.equal(result.rowCount, 1);
});

test("mysql: OkPacket stays an execution result", () => {
  const result = shapeMysqlResult({ affectedRows: 3 }, undefined, 100, Date.now());
  assert.equal(result.command, "OK");
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.rows, []);
});

test("mysql: multi-statement scripts expose the last result set", () => {
  const result = shapeMysqlResult(
    [[{ a: 1 }], [{ b: 2 }, { b: 3 }]],
    [[{ name: "a", type: 8 }], [{ name: "b", type: 8 }]],
    100,
    Date.now(),
  );
  assert.equal(result.command, "SELECT");
  assert.deepEqual(result.columns.map((column) => column.name), ["b"]);
  assert.deepEqual(result.rows, [[2], [3]]);
});

test("mysql: SELECT honours maxRows truncation", () => {
  const result = shapeMysqlResult([{ a: 1 }, { a: 2 }, { a: 3 }], [{ name: "a", type: 8 }], 2, Date.now());
  assert.equal(result.rows.length, 2);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, true);
});

test("mysql: DML execution result carries the statement command", () => {
  const result = shapeMysqlResult({ affectedRows: 3 }, undefined, 100, Date.now(), "UPDATE users SET a = 1");
  assert.equal(result.command, "UPDATE");
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.rows, []);
});

test("commandFromSql: labels statements the drivers do not label", () => {
  assert.equal(commandFromSql("insert into t values (1)"), "INSERT");
  assert.equal(commandFromSql("  -- a note\n/* b */\nDELETE FROM t"), "DELETE");
  assert.equal(commandFromSql("create table t (id int)"), "CREATE");
  assert.equal(commandFromSql("truncate table t;"), "TRUNCATE");
  assert.equal(commandFromSql("with x as (select 1) update t set a = 1"), "UPDATE");
  assert.equal(commandFromSql("with x as (select 1) select * from x"), "SELECT");
  assert.equal(commandFromSql(""), "OK");
});

test("test connection uses a throwaway session and leaves the live one alone", async () => {
  const target = { id: "sqlite-isolated-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    assert.equal((await handlers.connect(target)).ok, true);
    assert.equal((await handlers.query({ target, sql: "create table kept (id integer)" })).ok, true);
    const live = __test.sessions.get(target.id);

    const tested = await handlers.test(target);
    assert.equal(tested.ok, true, JSON.stringify(tested));

    // Same in-memory database: the test neither replaced nor closed it.
    assert.equal(__test.sessions.get(target.id), live);
    const selected = await handlers.query({ target, sql: "select count(*) as n from kept" });
    assert.equal(selected.ok, true, JSON.stringify(selected));
  } finally {
    await handlers.disconnect({ id: target.id });
  }
});

test("edited connection settings replace the cached session", async () => {
  const target = { id: "sqlite-fingerprint-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    assert.equal((await handlers.query({ target, sql: "create table old_db (id integer)" })).ok, true);
    const first = __test.sessions.get(target.id);
    const edited = { ...target, initSql: "select 1" };
    const result = await handlers.query({ target: edited, sql: "select * from old_db" });
    assert.equal(result.ok, false, "the edited target must not reuse the old in-memory database");
    assert.notEqual(__test.sessions.get(target.id), first);
    assert.equal(first.closed, true);
  } finally {
    await handlers.disconnect({ id: target.id });
  }
});

test("connectionFingerprint changes with the password but not with object identity", () => {
  const base = { id: "c", kind: "postgresql", host: "db", port: 5432, username: "u", password: "s3cr3t-pass" };
  assert.equal(__test.connectionFingerprint(base), __test.connectionFingerprint({ ...base }));
  assert.notEqual(
    __test.connectionFingerprint(base),
    __test.connectionFingerprint({ ...base, password: "other-pass" }),
  );
  assert.match(__test.connectionFingerprint(base), /^[0-9a-f]{64}$/, "hashed, not the raw password");
});

test("typed BEGIN / COMMIT keep the transaction state in sync", async () => {
  const target = { id: "sqlite-typed-tx-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    await handlers.query({ target, sql: "create table t (n integer)" });
    const begun = await handlers.query({ target, sql: "BEGIN" });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    assert.equal(begun.transactionOpen, true);
    const inside = await handlers.query({ target, sql: "insert into t values (1)" });
    assert.equal(inside.transactionOpen, true);
    const committed = await handlers.query({ target, sql: "COMMIT" });
    assert.equal(committed.transactionOpen, false);
    const controlled = await handlers.control({ target, action: "begin" });
    assert.equal(controlled.transactionOpen, true);
    const rolledBack = await handlers.control({ target, action: "rollback" });
    assert.equal(rolledBack.transactionOpen, false);
  } finally {
    await handlers.disconnect({ id: target.id });
  }
});

test("a reconnect under an open transaction is reported instead of auto-committing", async () => {
  const target = { id: "sqlite-lost-tx-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    assert.equal((await handlers.control({ target, action: "begin" })).ok, true);
    const entry = __test.sessions.get(target.id);
    // Simulate a dropped connection: the driver now reports a new generation.
    entry.session.generation = () => 99;
    const result = await handlers.query({ target, sql: "select 1" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "transaction-lost");
    assert.equal(result.transactionOpen, false);
    // Reported once; the next statement runs normally on the new connection.
    const next = await handlers.query({ target, sql: "select 1" });
    assert.equal(next.ok, true, JSON.stringify(next));
  } finally {
    await handlers.disconnect({ id: target.id });
  }
});

test("cancel stops the running statement and reports query-cancelled", async () => {
  const target = { id: "sqlite-cancel-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    const entry = __test.getSession(target);
    let rejectRunning;
    let cancelCalls = 0;
    entry.session = {
      ...entry.session,
      query: () => new Promise((_resolve, reject) => {
        rejectRunning = reject;
      }),
      cancel: async () => {
        cancelCalls += 1;
        rejectRunning?.(new Error("canceling statement due to user request"));
      },
    };
    const pending = handlers.query({ target, sql: "select pg_sleep(60)" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await handlers.cancel({ id: target.id });
    assert.deepEqual(cancelled, { ok: true, cancelled: true });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "query-cancelled");
    assert.equal(cancelCalls, 1);
    assert.equal(entry.closed, false, "a cancel that settles keeps the session");
  } finally {
    await handlers.disconnect({ id: target.id });
  }
});

test("a timed out statement asks the driver to cancel and keeps a session that settles", async () => {
  const target = { id: "sqlite-timeout-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    const entry = __test.getSession(target);
    let rejectRunning;
    entry.session = {
      ...entry.session,
      query: () => new Promise((_resolve, reject) => {
        rejectRunning = reject;
      }),
      cancel: async () => rejectRunning?.(new Error("statement timeout")),
    };
    const result = await handlers.query({ target, sql: "select slow()", timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "query-timeout");
    assert.equal(entry.closed, false);
  } finally {
    await handlers.disconnect({ id: target.id });
  }
});

test("transactionEffectOf follows dialect rules", () => {
  const effect = __test.transactionEffectOf;
  assert.equal(effect("postgresql", "BEGIN"), "begin");
  assert.equal(effect("postgresql", "begin isolation level serializable;"), "begin");
  assert.equal(effect("mysql", "START TRANSACTION"), "begin");
  assert.equal(effect("postgresql", "-- note\nCOMMIT"), "commit");
  assert.equal(effect("postgresql", "ROLLBACK TO SAVEPOINT s1"), null);
  assert.equal(effect("oracle", "BEGIN dbms_output.put_line('x'); END;"), null);
  assert.equal(effect("oracle", "ROLLBACK"), "rollback");
  assert.equal(effect("sqlserver", "BEGIN TRAN"), null);
  assert.equal(effect("postgresql", "select 1"), null);
});

test("settleWithin and resolvesWithin never reject", async () => {
  assert.equal(await __test.settleWithin(Promise.reject(new Error("x")), 50), true);
  assert.equal(await __test.resolvesWithin(Promise.reject(new Error("x")), 50), false);
  assert.equal(await __test.resolvesWithin(Promise.resolve(1), 50), true);
  assert.equal(await __test.settleWithin(new Promise(() => {}), 20), false);
});
