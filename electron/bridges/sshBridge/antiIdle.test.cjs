const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decodeAntiIdleText,
  resolveAntiIdlePolicy,
  startAntiIdle,
} = require("./antiIdle.cjs");

test("decodeAntiIdleText expands escapes and defaults to Enter", () => {
  assert.equal(decodeAntiIdleText(undefined), "\n");
  assert.equal(decodeAntiIdleText(""), "\n");
  assert.equal(decodeAntiIdleText("\\n"), "\n");
  assert.equal(decodeAntiIdleText("\\r"), "\r");
  assert.equal(decodeAntiIdleText(" \\x7f"), " \x7f");
  assert.equal(decodeAntiIdleText("\\x00"), "\x00");
  assert.equal(decodeAntiIdleText("a\\\\n"), "a\\n");
  assert.equal(decodeAntiIdleText("date\\n"), "date\n");
});

test("resolveAntiIdlePolicy is off unless a positive interval is given", () => {
  assert.equal(resolveAntiIdlePolicy({}), null);
  assert.equal(resolveAntiIdlePolicy({ antiIdleIntervalSec: 0 }), null);
  assert.equal(resolveAntiIdlePolicy({ antiIdleIntervalSec: "x" }), null);
  assert.deepEqual(resolveAntiIdlePolicy({ antiIdleIntervalSec: 60 }), {
    intervalMs: 60000,
    data: "\n",
  });
  assert.deepEqual(resolveAntiIdlePolicy({ antiIdleIntervalSec: 1, antiIdleText: " " }), {
    intervalMs: 5000,
    data: " ",
  });
});

function harness(policy) {
  let clock = 1000;
  let tick = null;
  let cleared = 0;
  const sent = [];
  const session = {};
  let alive = true;
  const stop = startAntiIdle({
    session,
    policy,
    send: (data) => sent.push(data),
    isAlive: () => alive,
    now: () => clock,
    setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalFn: () => { cleared += 1; },
  });
  return {
    session,
    sent,
    stop,
    advance(ms) { clock += ms; tick(); },
    kill() { alive = false; },
    get cleared() { return cleared; },
    get clock() { return clock; },
  };
}

test("startAntiIdle types the text only after a full idle interval", () => {
  const h = harness({ intervalMs: 60000, data: "\n" });
  h.advance(30000);
  assert.deepEqual(h.sent, []);
  h.advance(30000);
  assert.deepEqual(h.sent, ["\n"]);
  // Its own keystroke restarts the interval.
  h.advance(59000);
  assert.deepEqual(h.sent, ["\n"]);
  h.advance(1000);
  assert.deepEqual(h.sent, ["\n", "\n"]);
});

test("startAntiIdle stays quiet while the session is active", () => {
  const h = harness({ intervalMs: 60000, data: "\n" });
  h.advance(50000);
  h.session.lastActivityAt = h.clock;
  h.advance(50000);
  assert.deepEqual(h.sent, []);
  h.advance(10000);
  assert.deepEqual(h.sent, ["\n"]);
});

test("startAntiIdle stops once the session is gone", () => {
  const h = harness({ intervalMs: 60000, data: "\n" });
  h.kill();
  h.advance(120000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.cleared, 1);
});

test("startAntiIdle does nothing without a policy", () => {
  const session = {};
  const stop = startAntiIdle({ session, policy: null, send: () => { throw new Error("no"); }, isAlive: () => true });
  stop();
  assert.equal(session.lastActivityAt, undefined);
});
