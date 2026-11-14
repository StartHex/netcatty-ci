const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createOnHostSession, sanitizeLoginSteps, summarizeDiagnostics } = require("./onHostSession.cjs");
const { buildFakes, hostEnv, startHost, targetFor, unavailableReason, HERE } = require("./tests/harness.cjs");

const skip = unavailableReason() ?? false;
// The fake host answers at once; keep failures quick.
const timeouts = { step: 4000, shellSync: 8000, shellRetry: 1500, env: 8000, pythonStart: 8000, agentReady: 15000 };

async function withHost(options, body) {
  const root = buildFakes();
  const host = await startHost({ env: hostEnv(root, options.env), command: options.command });
  const sessions = [];
  const open = (onHost, extra) => {
    const session = createOnHostSession(targetFor(host, onHost, extra), { timeouts });
    sessions.push(session);
    return session;
  };
  try {
    await body({ host, open, root });
  } finally {
    for (const session of sessions) session.forceClose();
    await host.close();
  }
}

test("sanitizeLoginSteps keeps usable steps only", () => {
  assert.deepEqual(
    sanitizeLoginSteps([{ expect: "IP:", send: "10.0.0.1" }, null, { send: "1", timeoutMs: 5000 }, { other: 1 }, "x"]),
    [{ expect: "IP:", send: "10.0.0.1" }, { expect: "", send: "1", timeoutMs: 5000 }],
  );
  assert.deepEqual(sanitizeLoginSteps(undefined), []);
});

test("summarizeDiagnostics lists what the host has", () => {
  const text = summarizeDiagnostics({
    python: "2.7.5",
    env: { DSCI_PATH: "/app/dsci" },
    libraries: [
      { name: "libdsci.so", ok: true, path: "/app/dsci/lib/libdsci.so" },
      { name: "libddci.so", ok: false, error: "libddci.so: cannot open shared object file" },
    ],
    dsciConfig: { path: "/app/dsci/cfg/db.cfg", exists: true, default: "DB01", dbs: [{ name: "DB01", type: "dmdb" }] },
  });
  assert.match(text, /Python 2\.7\.5/);
  assert.match(text, /DSCI_PATH=\/app\/dsci/);
  assert.match(text, /DCI_HOME=\(not set\)/);
  assert.match(text, /libdsci\.so: loaded \(\/app\/dsci\/lib\/libdsci\.so\)/);
  assert.match(text, /libddci\.so: libddci\.so: cannot open shared object file/);
  assert.match(text, /db\.cfg: DB01=dmdb; default DB01/);
});

test("a login shell on the host runs statements through the host's DSCI configuration", { skip }, async () => {
  await withHost({}, async ({ open }) => {
    const session = open({ mode: "config" });
    assert.equal(await session.serverVersion(), "DSCI 2.0.0.1 · DB02 (dmdb) · via dsci+ddci");
    assert.equal(session.generation(), 1);

    // Sequences are left out, views are marked.
    assert.deepEqual(await session.tables(), [
      { schema: "APP", name: "T_SMALL", type: "table" },
      { schema: "APP", name: "T_BIG", type: "table" },
      { schema: "APP", name: "V_ONE", type: "view" },
    ]);

    assert.deepEqual(await session.columns("APP", "T_SMALL"), [
      { name: "ID", type: "INT", nullable: false, primaryKey: true },
      { name: "NAME", type: "VARCHAR(32)", nullable: true, primaryKey: false },
      { name: "NOTE", type: "VARCHAR(64)", nullable: true, primaryKey: false },
    ]);

    // This client library reports no column names: a plain star takes them
    // from the table, anything else falls back to numbered columns.
    const small = await session.query("select * from app.t_small", { maxRows: 100, timeoutMs: 30000 });
    assert.deepEqual(small.columns, [
      { name: "ID", type: "INT" },
      { name: "NAME", type: "VARCHAR(32)" },
      { name: "NOTE", type: "VARCHAR(64)" },
    ]);
    assert.deepEqual(small.rows, [
      ["1", "alice", "plain"],
      ["2", "张三", null],
      ["3", "tab\there", "line1\nline2"],
    ]);
    assert.equal(small.command, "SELECT");
    assert.equal(small.truncated, false);

    const labelled = await session.query("select id, name as who, note from t_small", { maxRows: 100, timeoutMs: 30000 });
    assert.deepEqual(labelled.columns.map((column) => column.name), ["id", "who", "note"]);
    const mismatch = await session.query("select id from t_small", { maxRows: 100, timeoutMs: 30000 });
    assert.deepEqual(mismatch.columns.map((column) => column.name), ["COL1", "COL2", "COL3"]);

    const big = await session.query("select * from t_big", { maxRows: 1200, timeoutMs: 30000 });
    assert.equal(big.rows.length, 1200);
    assert.deepEqual(big.rows[1199], ["1200", "value-1200"]);
    assert.equal(big.truncated, true);

    const insert = await session.query("insert into t_small values (9, 'x', 'y') /*n=4*/", { maxRows: 100, timeoutMs: 30000 });
    assert.deepEqual([insert.rowCount, insert.command, insert.rows], [4, "INSERT", []]);
    assert.deepEqual(await session.execute("delete from t_small"), { rowCount: 1 });

    const stats = async () => {
      const result = await session.query("select commits, rollbacks, pending, breaks, connects from fake_stats", { maxRows: 10, timeoutMs: 30000 });
      const [commits, rollbacks, pending] = result.rows[0].map(Number);
      return { commits, rollbacks, pending };
    };
    const before = await stats();
    await session.control("begin");
    await session.query("update t_small set name = 'z'", { maxRows: 100, timeoutMs: 30000 });
    assert.deepEqual(await stats(), { ...before, pending: 1 }, "nothing is committed inside a transaction");
    await session.control("rollback");
    assert.deepEqual(await stats(), { ...before, rollbacks: before.rollbacks + 1 });
    await session.control("begin");
    await session.query("update t_small set name = 'z'", { maxRows: 100, timeoutMs: 30000 });
    await session.control("commit");
    assert.deepEqual(await stats(), { commits: before.commits + 1, rollbacks: before.rollbacks + 1, pending: 0 });

    await assert.rejects(
      session.query("select boom from dual", { maxRows: 10, timeoutMs: 30000 }),
      (error) => error.code === "db-error" && error.native === 2100 && /synthetic failure/.test(error.message),
    );
    assert.equal((await session.query("select 1 from dual", { maxRows: 10, timeoutMs: 30000 })).rows[0][0], "1");
    await session.close();
  });
});

test("column names come from the library when it has them", { skip }, async () => {
  await withHost({}, async ({ open }) => {
    const session = open({ mode: "config", dbNo: 1 });
    assert.match(await session.serverVersion(), /DB01 \(imdb\) · via dsci\+si_dci$/);
    const result = await session.query("select id from t_small", { maxRows: 10, timeoutMs: 30000 });
    assert.deepEqual(result.columns, [
      { name: "ID", type: "INT" },
      { name: "NAME", type: "CHAR(32)" },
      { name: "NOTE", type: "CHAR(64)" },
    ]);
    const lob = await session.query("select * from t_lob", { maxRows: 10, timeoutMs: 30000 });
    assert.deepEqual(lob.rows[0], ["1", "clob text", "0x0001FEFF"]);
  });
});

test("a direct login reports the library's reason and what the host has", { skip }, async () => {
  await withHost({}, async ({ open }) => {
    const good = open({ mode: "direct", dbType: "dmdb", server: "cluster:9500" });
    assert.match(await good.serverVersion(), /dmdb:cluster:9500/);

    const bad = open({ mode: "direct", dbType: "dmdb", server: "cluster:9500" }, { password: "wrong" });
    await assert.rejects(bad.serverVersion(), (error) => {
      assert.equal(error.code, "connect-failed");
      assert.match(error.message, /invalid username\/password/);
      assert.match(error.detail, /libdsci\.so: loaded/);
      assert.match(error.detail, /DSCI_PATH=/);
      return true;
    });
    // A failed connect is not cached: fixing the password is enough.
    await assert.rejects(bad.serverVersion(), /invalid username/);
  });
});

test("the environment command prepares a shell that lacks the library paths", { skip }, async () => {
  await withHost({ env: { dsci: null, mdb: false, ddci: false } }, async ({ open, root }) => {
    const missing = open({ mode: "config" });
    await assert.rejects(missing.serverVersion(), (error) => {
      assert.equal(error.code, "library-missing");
      assert.match(error.detail, /DSCI_PATH=\(not set\)/);
      return true;
    });
    const prepared = open({
      mode: "config",
      envCommand: [
        `export DSCI_PATH=${path.join(root, "dsci")}`,
        `export LD_LIBRARY_PATH=${path.join(root, "dsci", "lib")}:${path.join(root, "mdb", "dci", "lib")}:${path.join(root, "ddci", "lib")}`,
      ].join("\n"),
    });
    assert.match(await prepared.serverVersion(), /DB02 \(dmdb\)/);
  });
});

test("login steps answer a bastion's prompts before the shell is used", { skip }, async () => {
  const command = `sh ${path.join(HERE, "fake_bastion.sh")}`;
  await withHost({ command }, async ({ open, host }) => {
    const session = open({
      mode: "config",
      loginSteps: [
        { expect: "请输入IP", send: "192.0.2.14" },
        { expect: "/Select account \\[\\d-\\d\\]/", send: "1" },
      ],
    });
    assert.match(await session.serverVersion(), /DB02 \(dmdb\)/);
    const rows = await session.query("select 1 from dual", { maxRows: 10, timeoutMs: 30000 });
    assert.equal(rows.rows[0][0], "1");
    assert.equal(host.sessions(), 1);

    // The bastion's own words explain a wrong answer.
    const wrongHost = open({ mode: "config", loginSteps: [{ expect: "请输入IP", send: "10.0.0.1" }] });
    await assert.rejects(wrongHost.serverVersion(), (error) => {
      assert.equal(error.code, "agent-exit");
      assert.match(error.detail, /host 10\.0\.0\.1 not found/);
      return true;
    });

    const neverAsked = open({ mode: "config", loginSteps: [{ expect: "Enter the OTP", send: "000000" }] });
    await assert.rejects(neverAsked.serverVersion(), (error) => {
      assert.equal(error.code, "onhost-login-step");
      assert.match(error.message, /Login step 1 timed out after 4s waiting for "Enter the OTP"/);
      assert.match(error.detail, /请输入IP/);
      return true;
    });
  });
});

test("a host without Python says so", { skip }, async () => {
  const stubs = fs.mkdtempSync(path.join(os.tmpdir(), "nc-nopython-"));
  for (const name of ["python3", "python", "python2"]) {
    fs.writeFileSync(path.join(stubs, name), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  }
  const root = buildFakes();
  const env = hostEnv(root);
  env.PATH = `${stubs}:${env.PATH}`;
  const host = await startHost({ env });
  const session = createOnHostSession(targetFor(host, { mode: "config" }), { timeouts });
  try {
    await assert.rejects(session.serverVersion(), (error) => {
      assert.equal(error.code, "onhost-no-python");
      assert.match(error.message, /No Python interpreter was found on the host \(tried python3, python, python2, \/usr\/libexec\/platform-python\)/);
      return true;
    });
  } finally {
    session.forceClose();
    await host.close();
    fs.rmSync(stubs, { recursive: true, force: true });
  }
});

test("cancel stops a statement the server is still working on, and the next one reconnects", { skip }, async () => {
  await withHost({}, async ({ open }) => {
    const session = open({ mode: "config", dbNo: 1 });
    await session.ensure();
    const started = Date.now();
    const outcome = session.query("select sleep 30 from dual", { maxRows: 10, timeoutMs: 60000 })
      .then(() => null, (error) => error);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await session.cancel();
    const error = await outcome;
    assert.ok(error && (error.code === "query-cancelled" || error.code === "agent-exit"), `unexpected outcome: ${error?.code}`);
    assert.ok(Date.now() - started < 10000, "did not wait for the statement");
    const again = await session.query("select 1 from dual", { maxRows: 10, timeoutMs: 30000 });
    assert.equal(again.rows[0][0], "1");
    assert.equal(session.generation(), 2);
  });
});

test("the relay token is required", { skip }, async () => {
  await withHost({}, async ({ host }) => {
    const session = createOnHostSession(targetFor(host, { mode: "config", relayToken: "wrong" }), { timeouts });
    await assert.rejects(session.serverVersion(), (error) => error.code === "agent-exit");
    const none = createOnHostSession({ ...targetFor(host, { mode: "config" }), port: undefined }, { timeouts });
    await assert.rejects(none.serverVersion(), (error) => error.code === "onhost-relay");
  });
});

async function waitFor(condition, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("closing a session that is still logging in ends the login on the host", { skip }, async () => {
  // A host that takes everything typed and never shows a shell: the login
  // would sit there until its timeout.
  await withHost({ command: "cat" }, async ({ host, open }) => {
    const session = open({ mode: "config" });
    const outcome = session.serverVersion().then(() => "opened", (error) => error);
    await waitFor(() => host.sessions() === 1, "the host has the session");

    const started = Date.now();
    await session.close();
    const error = await outcome;
    assert.equal(error.code, "agent-exit");
    assert.match(error.message, /closed while it was being opened/);
    assert.ok(Date.now() - started < 3000, "the login is not waited out");
    await waitFor(() => host.sessions() === 0, "the shell on the host is gone");

    // The session is not spent: asked again, it logs in again.
    const again = session.serverVersion().then(() => "opened", (failure) => failure);
    await waitFor(() => host.sessions() === 1, "a new login has started");
    session.forceClose();
    assert.equal((await again).code, "agent-exit");
    await waitFor(() => host.sessions() === 0, "and is gone again");
  });
});

test("a close that arrives while the relay is being dialed does not leave a shell behind", { skip }, async () => {
  await withHost({}, async ({ host }) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { connectRelay } = require("./onHostSession.cjs");
    const target = targetFor(host, { mode: "config" });
    const session = createOnHostSession(target, {
      timeouts,
      // The dial itself is held, as a slow loopback connect would be.
      connect: async (dialed) => {
        await gate;
        return connectRelay(dialed);
      },
    });
    const outcome = session.serverVersion().then(() => "opened", (error) => error);
    await session.close();
    release();
    const error = await outcome;
    assert.equal(error.code, "agent-exit");
    await waitFor(() => host.sessions() === 0, "no shell is left on the host");
  });
});
