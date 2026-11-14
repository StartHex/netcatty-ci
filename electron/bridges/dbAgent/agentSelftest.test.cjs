const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { unavailableReason } = require("./tests/harness.cjs");

// The agent has its own test suite in Python, because it has to behave the
// same on the Python 2 and Python 3 interpreters hosts come with. CI runs it
// under both; here it runs under whatever python3 this machine has.
test("the on-host agent passes its Python test suite", { skip: unavailableReason() ?? false }, () => {
  const result = spawnSync("python3", [path.join(__dirname, "tests", "agent_selftest.py")], {
    encoding: "utf8",
    timeout: 240000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /0 failed tests/);
});
