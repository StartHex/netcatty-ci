const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { JdbcSidecar } = require("./jdbcSidecar.cjs");

test("an exited sidecar reports its signal and notifies the owner", async () => {
  let notified = null;
  const instance = new JdbcSidecar({ onExit: (info) => { notified = info; } });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  instance.child = child;
  const pending = instance.request("QUERY", { sql: "select 1" });
  instance.stderrTail = "";
  instance.onExit(null, "SIGKILL");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "sidecar-exit");
  assert.match(result.error.message, /signal SIGKILL/);
  assert.deepEqual(notified, { code: null, signal: "SIGKILL" });
  assert.equal(instance.child, null);
});

test("a crashed sidecar keeps its stderr tail in the message", async () => {
  const instance = new JdbcSidecar({});
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  instance.child = child;
  const pending = instance.request("QUERY", { sql: "select 1" });
  instance.stderrTail = "Exception in thread \"main\" java.lang.OutOfMemoryError";
  instance.onExit(1, null);
  const result = await pending;
  assert.match(result.error.message, /code 1/);
  assert.match(result.error.message, /OutOfMemoryError/);
});

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true, end: () => {} };
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal ?? "SIGTERM");
    return true;
  };
  return child;
};

test("kill detaches at once: pending requests fail and a late exit is ignored", async () => {
  let exits = 0;
  const instance = new JdbcSidecar({ onExit: () => { exits += 1; } });
  const child = fakeChild();
  instance.child = child;
  const pending = instance.request("QUERY", { sql: "select sleep(60)" });
  instance.kill();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "sidecar-exit");
  assert.equal(instance.child, null);
  assert.deepEqual(child.killed, ["SIGTERM"]);
  // The real exit event arrives later and must not touch a newer child.
  const next = fakeChild();
  instance.child = next;
  child.emit("exit", null, "SIGTERM");
  assert.equal(instance.child, next);
  assert.equal(exits, 1);
});

test("stop does not wait forever for a SHUTDOWN stuck behind a statement", async () => {
  const instance = new JdbcSidecar({});
  const child = fakeChild();
  instance.child = child;
  const running = instance.request("QUERY", { sql: "select sleep(60)" });
  const started = Date.now();
  await instance.stop();
  assert.ok(Date.now() - started < 3000, "stop is bounded");
  assert.equal(instance.child, null);
  const result = await running;
  assert.equal(result.error.code, "sidecar-exit");
});

test("a write to a dead stdin resolves instead of throwing", async () => {
  const instance = new JdbcSidecar({});
  const child = fakeChild();
  child.stdin.write = () => {
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  };
  instance.child = child;
  const result = await instance.request("PING");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "sidecar-exit");
  assert.match(result.error.message, /EPIPE/);
});
