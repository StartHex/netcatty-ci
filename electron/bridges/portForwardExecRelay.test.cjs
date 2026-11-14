const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");

const {
  isSafeRelayTarget,
  isForwardProhibitedError,
  buildRelayCommand,
  buildProbeCommand,
  openExecRelay,
  probeTargetFromHostShell,
  verifyForwardTarget,
} = require("./portForwardExecRelay.cjs");

const hasBash = process.platform !== "win32"
  && spawnSync("sh", ["-c", "command -v bash"]).status === 0;

test("only plain hosts and ports are pasted into the relay command", () => {
  assert.equal(isSafeRelayTarget("137.0.26.30", 9256), true);
  assert.equal(isSafeRelayTarget("db-01.example.com", 1521), true);
  assert.equal(isSafeRelayTarget("fd00::1", 5432), true);
  assert.equal(isSafeRelayTarget("a; rm -rf /", 22), false);
  assert.equal(isSafeRelayTarget("$(id)", 22), false);
  assert.equal(isSafeRelayTarget("a b", 22), false);
  assert.equal(isSafeRelayTarget("-oProxyCommand", 22), false);
  assert.equal(isSafeRelayTarget("host", 0), false);
  assert.equal(isSafeRelayTarget("host", "22; id"), false);
  assert.throws(() => buildRelayCommand("x'y", 1), /not a plain host/);
  assert.throws(() => buildProbeCommand("x`id`", 1), /not a plain host/);
  assert.equal(buildRelayCommand("h", 1).split("'").length, 3, "script must not contain single quotes");
  assert.equal(buildProbeCommand("h", 1).split("'").length, 3, "script must not contain single quotes");
});

test("isForwardProhibitedError separates a refusing server from a refusing target", () => {
  assert.equal(isForwardProhibitedError({ reason: 1, message: "(SSH) Channel open failure: open failed" }), true);
  assert.equal(isForwardProhibitedError({ reason: 3, message: "unknown" }), true);
  assert.equal(isForwardProhibitedError(new Error("(SSH) Channel open failure: administratively prohibited")), true);
  assert.equal(isForwardProhibitedError({ reason: 2, message: "(SSH) Channel open failure: Connection refused" }), false);
  assert.equal(isForwardProhibitedError(new Error("timed out")), false);
  assert.equal(isForwardProhibitedError(null), false);
});

function listen(onConnection) {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runShell(command) {
  return spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
}

function waitExit(child, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("relay did not exit"));
    }, ms);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("the relay command copies bytes both ways and ends when the target closes", { skip: !hasBash }, async () => {
  const received = [];
  const server = await listen((socket) => {
    socket.on("data", (chunk) => {
      received.push(chunk);
      if (Buffer.concat(received).length >= 5) {
        // Binary-safe echo, then the target hangs up.
        socket.end(Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x80]));
      }
    });
  });
  try {
    const child = runShell(buildRelayCommand("127.0.0.1", server.address().port));
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stdin.write(Buffer.from([0x01, 0x00, 0xfe, 0x0a, 0x7f]));
    await waitExit(child);
    assert.deepEqual(Buffer.concat(received), Buffer.from([0x01, 0x00, 0xfe, 0x0a, 0x7f]));
    assert.deepEqual(Buffer.concat(out), Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x80]));
  } finally {
    server.close();
  }
});

test("the relay command hangs up on the target when the client side closes", { skip: !hasBash }, async () => {
  let targetClosed;
  const closed = new Promise((resolve) => { targetClosed = resolve; });
  const server = await listen((socket) => {
    socket.on("data", () => {});
    socket.on("close", targetClosed);
    socket.on("error", () => {});
  });
  try {
    const child = runShell(buildRelayCommand("127.0.0.1", server.address().port));
    child.stdin.write("hello");
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.end();
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("target connection was left open")), 8000)),
    ]);
    await waitExit(child);
  } finally {
    server.close();
  }
});

test("the probe command reports whether the target accepts connections", { skip: !hasBash }, async () => {
  const server = await listen((socket) => socket.end());
  const port = server.address().port;
  try {
    assert.equal((await waitExit(runShell(buildProbeCommand("127.0.0.1", port)))).code, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const closedPort = await waitExit(runShell(buildProbeCommand("127.0.0.1", port)), 20000);
  assert.notEqual(closedPort.code, 0);
});

function fakeConn(behaviour) {
  return {
    exec(command, callback) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      setImmediate(() => {
        callback(behaviour.error || null, behaviour.error ? undefined : stream);
        if (!behaviour.error) setImmediate(() => behaviour.run?.(stream, command));
      });
    },
  };
}

test("openExecRelay hands back the command's stream and remembers its stderr", async () => {
  let seenCommand = "";
  const conn = fakeConn({
    run(stream, command) {
      seenCommand = command;
      stream.stderr.emit("data", Buffer.from("bash: connect: Connection refused\n"));
    },
  });
  const stream = await new Promise((resolve, reject) => {
    openExecRelay(conn, "10.0.0.9", 9256, (error, value) => (error ? reject(error) : resolve(value)));
  });
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.match(seenCommand, /\/dev\/tcp\/\$H\/\$P/);
  assert.match(seenCommand, /H=10\.0\.0\.9; P=9256/);
  assert.equal(stream.relayStderr(), "bash: connect: Connection refused");
});

test("openExecRelay refuses targets that are not plain addresses", async () => {
  const error = await new Promise((resolve) => {
    openExecRelay(fakeConn({}), "x; id", 1, (err) => resolve(err));
  });
  assert.match(error.message, /not a plain host/);
});

test("probeTargetFromHostShell maps the exit code to ok and keeps the reason", async () => {
  const ok = await probeTargetFromHostShell(fakeConn({
    run(stream) { stream.emit("exit", 0); stream.emit("close"); },
  }), "10.0.0.9", 9256);
  assert.deepEqual(ok, { ok: true, detail: "" });

  const refused = await probeTargetFromHostShell(fakeConn({
    run(stream) {
      stream.stderr.emit("data", "bash: connect: Connection refused\n");
      stream.emit("exit", 1);
      stream.emit("close");
    },
  }), "10.0.0.9", 9256);
  assert.deepEqual(refused, { ok: false, detail: "bash: connect: Connection refused" });

  const noExec = await probeTargetFromHostShell(fakeConn({ error: new Error("exec request failed") }), "10.0.0.9", 9256);
  assert.deepEqual(noExec, { ok: false, detail: "exec request failed" });
});

test("verifyForwardTarget passes when the server forwards", async () => {
  let closed = 0;
  const result = await verifyForwardTarget({
    conn: fakeConn({ error: new Error("exec must not be used") }),
    host: "10.0.0.9",
    port: 9256,
    openForwardOut: async () => ({ id: 1 }),
    closeChannel: () => { closed += 1; },
  });
  assert.deepEqual(result, { execRelay: false });
  assert.equal(closed, 1);
});

test("verifyForwardTarget reports a target the host cannot reach", async () => {
  await assert.rejects(
    verifyForwardTarget({
      conn: fakeConn({ error: new Error("exec must not be used") }),
      host: "10.0.0.9",
      port: 9256,
      openForwardOut: async () => {
        throw Object.assign(new Error("(SSH) Channel open failure: Connection refused"), { reason: 2 });
      },
    }),
    /the SSH host could not connect to 10\.0\.0\.9:9256 \(Channel open failure: Connection refused\)/,
  );
});

test("verifyForwardTarget switches to the relay when forwarding is refused but the shell can connect", async () => {
  const prohibited = async () => {
    throw Object.assign(new Error("(SSH) Channel open failure: open failed"), { reason: 1 });
  };
  const viaRelay = await verifyForwardTarget({
    conn: fakeConn({ run(stream) { stream.emit("exit", 0); stream.emit("close"); } }),
    host: "10.0.0.9",
    port: 9256,
    openForwardOut: prohibited,
  });
  assert.deepEqual(viaRelay, { execRelay: true });

  await assert.rejects(
    verifyForwardTarget({
      conn: fakeConn({
        run(stream) {
          stream.stderr.emit("data", "bash: connect: No route to host\n");
          stream.emit("exit", 1);
          stream.emit("close");
        },
      }),
      host: "10.0.0.9",
      port: 9256,
      openForwardOut: prohibited,
    }),
    /does not allow port forwarding, and could not connect to 10\.0\.0\.9:9256 from its shell either \(bash: connect: No route to host\)/,
  );
});
