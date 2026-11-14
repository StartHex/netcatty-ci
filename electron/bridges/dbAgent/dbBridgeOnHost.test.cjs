"use strict";

// The on-host driver as the workbench uses it: through the database bridge's
// handlers, against a login shell whose client libraries are test doubles.

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const { handlers, __test } = require("../dbBridge.cjs");
const { PING_SQL } = require("./onHostSession.cjs");
const { buildFakes, hostEnv, startHost, targetFor, unavailableReason } = require("./tests/harness.cjs");

const skip = unavailableReason() ?? false;

async function withHost(options, body) {
  const root = buildFakes();
  const host = await startHost({ env: hostEnv(root, options.env), command: options.command });
  const ids = new Set();
  const target = (onHost, extra) => {
    const built = targetFor(host, onHost, extra);
    ids.add(built.id);
    return built;
  };
  try {
    await body({ host, target });
  } finally {
    for (const id of ids) await handlers.disconnect({ id });
    await host.close();
  }
}

test("the bridge has an on-host driver and treats its settings as part of the connection", () => {
  const base = { id: "c", kind: "onhost", host: "127.0.0.1", port: 5000, username: "app" };
  const fingerprint = (onHost) => __test.connectionFingerprint({ ...base, onHost });
  assert.notEqual(
    fingerprint({ mode: "config", dbNo: 1, relayToken: "t" }),
    fingerprint({ mode: "config", dbNo: 2, relayToken: "t" }),
    "another database on the host is another session",
  );
  assert.notEqual(
    fingerprint({ mode: "config", relayToken: "old" }),
    fingerprint({ mode: "config", relayToken: "new" }),
    "a new relay is a new login",
  );
  assert.equal(
    fingerprint({ mode: "config", relayToken: "t" }),
    fingerprint({ mode: "config", relayToken: "t" }),
  );
});

test("connect, query, schema and transactions go through the bridge handlers", { skip }, async () => {
  await withHost({}, async ({ target }) => {
    const conn = target({ mode: "config" });

    const connected = await handlers.connect(conn);
    assert.equal(connected.ok, true, JSON.stringify(connected.error));
    assert.match(connected.serverVersion, /DSCI .* DB02 \(dmdb\)/);

    const queried = await handlers.query({ target: conn, sql: "select id, name as who, note from t_small", maxRows: 10 });
    assert.equal(queried.ok, true, JSON.stringify(queried.error));
    assert.deepEqual(queried.result.columns.map((column) => column.name), ["id", "who", "note"]);
    assert.ok(queried.result.rows.length > 0);
    assert.equal(queried.transactionOpen, false);

    const tables = await handlers.tables({ target: conn });
    assert.equal(tables.ok, true, JSON.stringify(tables.error));
    assert.ok(tables.tables.length > 0);

    const begun = await handlers.control({ target: conn, action: "begin" });
    assert.equal(begun.ok, true, JSON.stringify(begun.error));
    assert.equal(begun.transactionOpen, true);
    const rolledBack = await handlers.control({ target: conn, action: "rollback" });
    assert.equal(rolledBack.ok, true, JSON.stringify(rolledBack.error));
    assert.equal(rolledBack.transactionOpen, false);

    // The idle check is answered by the agent, whatever engine is behind it.
    const ping = await handlers.query({ target: conn, sql: PING_SQL, maxRows: 1 });
    assert.equal(ping.ok, true, JSON.stringify(ping.error));
    assert.equal(ping.result.command, "PING");

    // BEGIN typed in the editor moves the badge too.
    const typedBegin = await handlers.query({ target: conn, sql: "begin" });
    assert.equal(typedBegin.ok, true, JSON.stringify(typedBegin.error));
    assert.equal(typedBegin.transactionOpen, true);
    const typedCommit = await handlers.query({ target: conn, sql: "commit" });
    assert.equal(typedCommit.ok, true, JSON.stringify(typedCommit.error));
    assert.equal(typedCommit.transactionOpen, false);
  });
});

test("the connection test reports what the host is missing", { skip }, async () => {
  await withHost({ env: { dsci: false, mdb: false, ddci: false } }, async ({ target }) => {
    const result = await handlers.test(target({ mode: "config" }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "library-missing");
    assert.match(result.error.detail, /libdsci\.so/);
    assert.match(result.error.detail, /Python \d/);
  });
});

test("a wrong relay token never reaches a shell", { skip }, async () => {
  await withHost({}, async ({ target }) => {
    const result = await handlers.test(target({ mode: "config", relayToken: "not-the-token" }));
    assert.equal(result.ok, false);
    assert.match(result.error.message, /host|shell|relay|closed|ended/i);
  });
});

test("an on-host target without a relay is refused with a message that says what to do", async () => {
  const result = await handlers.test({ id: "c-none", kind: "onhost", username: "app", onHost: { mode: "config" } });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /SSH host/);
});

test("the driver recognises exactly the liveness statement the workbench sends", () => {
  const probe = fs.readFileSync(path.join(__dirname, "..", "..", "..", "domain", "database", "probe.ts"), "utf8");
  const declared = /export const ON_HOST_PING_SQL = '([^']+)';/.exec(probe);
  assert.ok(declared, "domain/database/probe.ts declares ON_HOST_PING_SQL");
  assert.equal(declared[1], PING_SQL);
});

