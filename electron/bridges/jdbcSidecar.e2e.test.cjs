"use strict";

/**
 * End-to-end tests for the JDBC path with a real JVM:
 *
 *   dbBridge handlers -> JDBC session -> JdbcSidecar (Node client)
 *     -> NetcattyJdbcSidecar.java (compiled like scripts/build-jdbc-sidecar.cjs)
 *     -> electron/jdbc-sidecar/test/FakeDriver.java
 *
 * The fake driver appends every transaction-relevant JDBC call to a log file,
 * so the tests can assert what actually reached the driver: that BEGIN turns
 * auto-commit off, that a cancelled statement is never replayed, that a
 * statement after a lost transaction never runs in auto-commit mode.
 *
 * Skipped when no JDK 17+ (java, javac, jar) is available.
 */

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { resolveJava } = require("./javaRuntime.cjs");
const { JdbcSidecar } = require("./jdbcSidecar.cjs");

const SIDECAR_SOURCE = path.join(__dirname, "..", "jdbc-sidecar", "src", "NetcattyJdbcSidecar.java");
const FAKE_DRIVER_SOURCE = path.join(__dirname, "..", "jdbc-sidecar", "test", "FakeDriver.java");

function findJdkTool(name, javaPath) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [];
  if (javaPath && javaPath.includes(path.sep)) candidates.push(path.join(path.dirname(javaPath), exe));
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, "bin", exe));
  candidates.push(exe);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, [name === "jar" ? "--version" : "-version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (probe.error || probe.status !== 0) continue;
    const match = /javac (\d+)(?:\.(\d+))?/.exec(`${probe.stdout}${probe.stderr}`);
    const major = match ? (match[1] === "1" ? Number(match[2]) : Number(match[1])) : null;
    return { path: candidate, major };
  }
  return null;
}

const java = resolveJava({});
const javac = java.ok ? findJdkTool("javac", java.path) : null;
const jarTool = java.ok ? findJdkTool("jar", java.path) : null;
const skip = java.ok && javac && javac.major >= 17 && jarTool ? false : "needs a JDK 17+ (java, javac, jar)";

const work = skip ? null : fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-jdbc-e2e-"));
const sidecarJar = work && path.join(work, "netcatty-jdbc-sidecar.jar");
const fakeJar = work && path.join(work, "fake-driver.jar");

function buildJars() {
  const run = (tool, args) => execFileSync(tool, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const sidecarClasses = path.join(work, "sidecar-classes");
  const fakeClasses = path.join(work, "fake-classes");
  fs.mkdirSync(sidecarClasses);
  fs.mkdirSync(fakeClasses);
  run(javac.path, ["-encoding", "UTF-8", "--release", "17", "-d", sidecarClasses, SIDECAR_SOURCE]);
  run(jarTool.path, ["cfe", sidecarJar, "NetcattyJdbcSidecar", "-C", sidecarClasses, "."]);
  run(javac.path, ["-encoding", "UTF-8", "--release", "17", "-d", fakeClasses, FAKE_DRIVER_SOURCE]);
  run(jarTool.path, ["cf", fakeJar, "-C", fakeClasses, "."]);
}

function eventLog(name) {
  const file = path.join(work, `${name}.log`);
  const read = () => {
    try {
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    url: `jdbc:fake:${file}`,
    all: read,
    mark: () => read().length,
    since: (from) => read().slice(from),
    /** Polls instead of sleeping so slow CI runners do not race the JVM. */
    async waitFor(line, from, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (read().slice(from).includes(line)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`driver never logged "${line}"`);
    },
  };
}

function exited(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  let timer;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("JDBC sidecar end to end", { skip }, () => {
  before(buildJars);

  after(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  describe("sidecar protocol", () => {
    const log = skip ? null : eventLog("sidecar");
    let sidecar;
    const connectParams = (connId, extra = {}) => ({
      connId,
      url: log.url,
      jars: fakeJar,
      driverClass: "FakeDriver",
      user: "alice",
      password: "secret",
      ...extra,
    });

    before(async () => {
      sidecar = new JdbcSidecar({ jarPath: sidecarJar });
      const started = await sidecar.start();
      assert.equal(started.ok, true, JSON.stringify(started));
    });

    after(() => {
      sidecar?.kill();
    });

    test("CONNECT applies the login timeout, driver properties and auto-commit", async () => {
      const response = await sidecar.request("CONNECT", connectParams("c1", {
        loginTimeoutSec: 7,
        "prop.characterEncoding": "utf8",
      }));
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.fields.product, "FakeDB");
      assert.equal(response.fields.version, "1.0");
      assert.deepEqual(log.all(), ["connect user=alice loginTimeout=7 charset=utf8", "setAutoCommit(true)"]);
    });

    test("CONNECT without a login timeout still bounds the login (20 s)", async () => {
      const from = log.mark();
      const response = await sidecar.request("CONNECT", connectParams("c-default"));
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(log.since(from)[0], "connect user=alice loginTimeout=20 charset=null");
      assert.equal((await sidecar.request("DISCONNECT", { connId: "c-default" })).ok, true);
    });

    test("BEGIN / UPDATE / COMMIT run inside a real transaction", async () => {
      const from = log.mark();
      assert.equal((await sidecar.request("BEGIN", { connId: "c1" })).ok, true);
      const update = await sidecar.request("UPDATE", { connId: "c1", sql: "INSERT x", timeoutSec: 5 });
      assert.equal(update.ok, true, JSON.stringify(update));
      assert.equal(update.fields.rows, "1");
      assert.equal((await sidecar.request("COMMIT", { connId: "c1" })).ok, true);
      assert.deepEqual(log.since(from), [
        "setAutoCommit(false)",
        "setQueryTimeout(5)",
        "execute(INSERT x)",
        "commit",
        "setAutoCommit(true)",
      ]);
    });

    test("BEGIN / UPDATE / ROLLBACK discard the work and restore auto-commit", async () => {
      const from = log.mark();
      assert.equal((await sidecar.request("BEGIN", { connId: "c1" })).ok, true);
      assert.equal((await sidecar.request("UPDATE", { connId: "c1", sql: "UPDATE y" })).ok, true);
      assert.equal((await sidecar.request("ROLLBACK", { connId: "c1" })).ok, true);
      assert.deepEqual(log.since(from), [
        "setAutoCommit(false)",
        "execute(UPDATE y)",
        "rollback",
        "setAutoCommit(true)",
      ]);
    });

    test("COMMIT / ROLLBACK outside a transaction are no-ops", async () => {
      const from = log.mark();
      assert.equal((await sidecar.request("COMMIT", { connId: "c1" })).ok, true);
      assert.equal((await sidecar.request("ROLLBACK", { connId: "c1" })).ok, true);
      assert.deepEqual(log.since(from), []);
    });

    test("QUERY streams rows, caps them without setMaxRows and applies the timeout", async () => {
      const from = log.mark();
      const response = await sidecar.request("QUERY", { connId: "c1", sql: "SELECT 3", maxRows: 2, timeoutSec: 9 });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.deepEqual(response.columns, [{ name: "id", type: "INT" }, { name: "name", type: "VARCHAR" }]);
      assert.deepEqual(response.rows, [["1", "row1"], ["2", "row2"]]);
      assert.equal(response.fields.rows, "2");
      assert.equal(response.fields.truncated, "true");
      assert.deepEqual(log.since(from), ["setQueryTimeout(9)", "execute(SELECT 3)", "setFetchSize(3)"]);
    });

    test("driver errors come back with message and SQLSTATE", async () => {
      const response = await sidecar.request("UPDATE", { connId: "c1", sql: "FAIL" });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "jdbc-error");
      assert.equal(response.error.message, "boom");
      assert.equal(response.error.sqlState, "42000");
    });

    test("an unknown connection is an error and the sidecar keeps serving", async () => {
      const response = await sidecar.request("COMMIT", { connId: "missing" });
      assert.equal(response.ok, false);
      assert.match(response.error.message, /Connection is not open/);
      assert.equal((await sidecar.request("PING")).ok, true);
    });

    test("kill() during a statement releases the caller at once and a fresh JVM starts", async () => {
      const child = sidecar.child;
      const from = log.mark();
      const pending = sidecar.request("UPDATE", { connId: "c1", sql: "SLEEP 60000" });
      await log.waitFor("execute(SLEEP 60000)", from);
      const killedAt = Date.now();
      sidecar.kill();
      const response = await pending;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "sidecar-exit");
      assert.ok(Date.now() - killedAt < 2000, "the caller must not wait for the busy JVM");
      assert.equal(await exited(child), true, "the busy JVM must actually exit");

      const restarted = await sidecar.start();
      assert.equal(restarted.ok, true, JSON.stringify(restarted));
      assert.notEqual(sidecar.child, child);
      assert.equal((await sidecar.request("PING")).ok, true);
      const stale = await sidecar.request("QUERY", { connId: "c1", sql: "SELECT 1" });
      assert.equal(stale.ok, false, "connections of the killed JVM are gone, nothing is replayed");
      assert.match(stale.error.message, /Connection is not open/);
    });

    test("stop() shuts down gracefully and closes open connections", async () => {
      assert.equal((await sidecar.request("CONNECT", connectParams("c2"))).ok, true);
      const child = sidecar.child;
      const from = log.mark();
      await sidecar.stop();
      assert.equal(sidecar.child, null);
      assert.equal(await exited(child), true);
      assert.deepEqual(log.since(from), ["close"]);
    });

    test("stop() during a statement is bounded and still terminates the JVM", async () => {
      assert.equal((await sidecar.start()).ok, true);
      assert.equal((await sidecar.request("CONNECT", connectParams("c3"))).ok, true);
      const child = sidecar.child;
      const from = log.mark();
      const pending = sidecar.request("UPDATE", { connId: "c3", sql: "SLEEP 60000" });
      await log.waitFor("execute(SLEEP 60000)", from);
      const stoppedAt = Date.now();
      await sidecar.stop();
      const took = Date.now() - stoppedAt;
      assert.ok(took < 6000, `stop() took ${took} ms`);
      const response = await pending;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "sidecar-exit");
      assert.equal(await exited(child), true, "a JVM stuck in a statement must still exit");
    });
  });

  describe("database bridge", () => {
    const log = skip ? null : eventLog("bridge");
    let handlers;
    let target;

    const runUntilCancelled = async () => {
      const from = log.mark();
      const running = handlers.query({ target, sql: "SLEEP 60000", timeoutMs: 120000 });
      await log.waitFor("execute(SLEEP 60000)", from);
      const cancelledAt = Date.now();
      const cancel = await handlers.cancel({ id: target.id });
      const response = await running;
      return { cancel, response, waitedMs: Date.now() - cancelledAt };
    };

    before(() => {
      // resolveSidecarJar() checks this before the packaged locations.
      process.env.NETCATTY_JDBC_SIDECAR_JAR = sidecarJar;
      ({ handlers } = require("./dbBridge.cjs"));
      target = {
        id: "jdbc-e2e",
        kind: "jdbc",
        jdbcUrl: log.url,
        jdbcDriverClass: "FakeDriver",
        jdbcDriverPaths: [fakeJar],
        username: "alice",
        password: "secret",
      };
    });

    after(async () => {
      await handlers?.dispose();
    });

    test("test() dials a throwaway session and closes it", async () => {
      const from = log.mark();
      const response = await handlers.test(target);
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.serverVersion, "FakeDB 1.0");
      const events = log.since(from);
      assert.match(events[0], /^connect user=alice loginTimeout=[1-9]\d* charset=null$/);
      assert.deepEqual(events.slice(1), ["setAutoCommit(true)", "close"]);
    });

    test("begin / statement / commit keep the transaction on the driver", async () => {
      assert.equal((await handlers.connect(target)).ok, true);
      const from = log.mark();
      assert.deepEqual(await handlers.control({ target, action: "begin" }), {
        ok: true,
        action: "begin",
        transactionOpen: true,
      });
      const inserted = await handlers.query({ target, sql: "INSERT x", timeoutMs: 5000 });
      assert.equal(inserted.ok, true, JSON.stringify(inserted));
      assert.equal(inserted.result.rowCount, 1);
      assert.equal(inserted.transactionOpen, true);
      assert.deepEqual(await handlers.control({ target, action: "commit" }), {
        ok: true,
        action: "commit",
        transactionOpen: false,
      });
      assert.deepEqual(log.since(from), [
        "setAutoCommit(false)",
        "setQueryTimeout(5)",
        "execute(INSERT x)",
        "commit",
        "setAutoCommit(true)",
      ]);
    });

    test("SELECT returns columns and rows and honours the row cap", async () => {
      const response = await handlers.query({ target, sql: "SELECT 5", maxRows: 3 });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.deepEqual(response.result.columns, [{ name: "id", type: "INT" }, { name: "name", type: "VARCHAR" }]);
      assert.equal(response.result.rowCount, 3);
      assert.equal(response.result.truncated, true);
    });

    test("cancel stops the statement promptly and never replays it", async () => {
      const from = log.mark();
      const { cancel, response, waitedMs } = await runUntilCancelled();
      assert.deepEqual(cancel, { ok: true, cancelled: true });
      assert.ok(waitedMs < 5000, `cancel took ${waitedMs} ms`);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "query-cancelled");
      assert.equal(response.transactionOpen, false);

      const next = await handlers.query({ target, sql: "SELECT 1" });
      assert.equal(next.ok, true, JSON.stringify(next));
      const events = log.since(from);
      assert.equal(events.filter((line) => line === "execute(SLEEP 60000)").length, 1, events.join("\n"));
      assert.ok(events.includes("execute(SELECT 1)"));
    });

    test("a statement after a cancelled transaction is refused, not auto-committed", async () => {
      assert.equal((await handlers.control({ target, action: "begin" })).transactionOpen, true);
      const from = log.mark();
      const { response } = await runUntilCancelled();
      assert.equal(response.error.code, "query-cancelled");

      const afterLoss = await handlers.query({ target, sql: "INSERT y" });
      assert.equal(afterLoss.ok, false, JSON.stringify(afterLoss));
      assert.equal(afterLoss.error.code, "transaction-lost");
      assert.equal(afterLoss.transactionOpen, false);
      assert.ok(!log.since(from).includes("execute(INSERT y)"), "INSERT y must not run in auto-commit mode");

      const retried = await handlers.query({ target, sql: "INSERT z" });
      assert.equal(retried.ok, true, JSON.stringify(retried));
      assert.equal(retried.transactionOpen, false);
    });

    test("COMMIT after a lost transaction is refused", async () => {
      assert.equal((await handlers.control({ target, action: "begin" })).ok, true);
      await runUntilCancelled();
      const from = log.mark();
      const commit = await handlers.control({ target, action: "commit" });
      assert.equal(commit.ok, false, JSON.stringify(commit));
      assert.equal(commit.error.code, "transaction-lost");
      assert.equal(commit.transactionOpen, false);
      assert.ok(!log.since(from).includes("commit"));
    });

    test("a statement past its timeout is stopped and the session recovers", async () => {
      const from = log.mark();
      const startedAt = Date.now();
      const response = await handlers.query({ target, sql: "SLEEP 60000", timeoutMs: 1000 });
      const took = Date.now() - startedAt;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "query-timeout");
      assert.ok(took >= 1000 && took < 15000, `timeout took ${took} ms`);
      assert.ok(log.since(from).includes("setQueryTimeout(1)"));

      const next = await handlers.query({ target, sql: "SELECT 1" });
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(log.since(from).filter((line) => line === "execute(SLEEP 60000)").length, 1);
    });

    test("driver errors keep their message", async () => {
      const response = await handlers.query({ target, sql: "FAIL" });
      assert.equal(response.ok, false);
      assert.match(response.error.message, /boom/);
    });

    test("disconnect() closes the driver connection", async () => {
      const from = log.mark();
      assert.deepEqual(await handlers.disconnect({ id: target.id }), { ok: true });
      assert.deepEqual(log.since(from), ["close"]);
    });
  });
});
