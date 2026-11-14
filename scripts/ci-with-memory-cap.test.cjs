const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "ci", "with-memory-cap.sh");
const testWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "test.yml"),
  "utf8",
);

const bash = process.platform === "win32" ? null : "bash";
const skip = bash ? false : "the wrapper is a bash script for the Linux CI job";

// MEMORY_CAP=off takes the plain path on every machine, so these checks do not
// depend on sudo or systemd being around (the capped path is exercised by the
// CI job itself, which runs this very suite inside it).
function run(args, env = {}) {
  return spawnSync(bash, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEMORY_CAP: "off", ...env },
  });
}

test("the wrapper runs the command and hands back its exit status", { skip }, () => {
  const ok = run(["sh", "-c", "echo ran; exit 0"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "ran\n");

  const failed = run(["sh", "-c", "exit 7"]);
  assert.equal(failed.status, 7);
});

test("arguments and the environment reach the command untouched", { skip }, () => {
  const result = run(
    ["node", "-e", "console.log(JSON.stringify([process.argv.slice(1), process.env.PROBE_VALUE]))", "two words", 'a "quoted" one'],
    { PROBE_VALUE: "kept\nacross lines" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [["two words", 'a "quoted" one'], "kept\nacross lines"]);
});

test("the wrapper refuses to run without a command", { skip }, () => {
  const result = run([]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage: with-memory-cap\.sh/);
});

test("no temporary environment file is left behind", { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "memory-cap-"));
  try {
    const result = run(["true"], { TMPDIR: tmp });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the jsdom suites of the test workflow run under the memory cap", () => {
  // Both steps render React into jsdom; a runaway failure diff in either one
  // used to take the runner down before any result was reported.
  assert.match(
    testWorkflow,
    /bash scripts\/ci\/with-memory-cap\.sh node --test --import tsx components\/settings\/tabs\/Plugin\*\.test\.tsx/,
  );
  assert.match(testWorkflow, /bash scripts\/ci\/with-memory-cap\.sh npm test/);
});
