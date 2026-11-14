"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const {
  RELAY_PTY,
  TOKEN_MAX_BYTES,
  authorizeRelayClient,
  createRelayToken,
  tokensMatch,
} = require("./portForwardShellRelay.cjs");

/** A loopback server that runs `authorizeRelayClient` on every connection. */
async function startGate(token, options) {
  const outcomes = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    authorizeRelayClient(socket, token, options).then(
      (rest) => {
        outcomes.push({ ok: true, rest: rest.toString("latin1") });
        // What a real relay does next: forward the leftover, then pipe.
        socket.write(`shell<${rest.toString("latin1")}>`);
        socket.on("data", (chunk) => socket.write(`echo<${chunk.toString("latin1")}>`));
        socket.resume();
      },
      (error) => {
        outcomes.push({ ok: false, error: error.message });
        socket.destroy();
      },
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    outcomes,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
}

const closed = (socket) => new Promise((resolve) => {
  if (socket.destroyed) resolve();
  else socket.once("close", resolve);
});

const nextData = (socket) => new Promise((resolve) => socket.once("data", (chunk) => resolve(chunk.toString("latin1"))));

test("tokens are random, long and compared exactly", () => {
  const first = createRelayToken();
  const second = createRelayToken();
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.notEqual(first, second);
  assert.equal(tokensMatch(first, first), true);
  assert.equal(tokensMatch(first, second), false);
  assert.equal(tokensMatch(first.slice(0, -1), first), false);
  assert.equal(tokensMatch("", ""), false, "an empty token never matches");
  assert.equal(tokensMatch(undefined, first), false);
});

test("the relay terminal is wide enough for the lines the driver types", () => {
  assert.equal(RELAY_PTY.term, "xterm");
  assert.ok(RELAY_PTY.cols >= 160);
  assert.ok(Object.isFrozen(RELAY_PTY));
});

test("a client with the token gets through, and bytes sent with the token are not lost", async (t) => {
  const token = createRelayToken();
  const gate = await startGate(token);
  t.after(gate.close);

  const socket = await connect(gate.port);
  socket.write(`${token}\necho first\n`);
  assert.equal(await nextData(socket), "shell<echo first\n>");
  socket.write("later");
  assert.equal(await nextData(socket), "echo<later>");
  socket.destroy();
  assert.deepEqual(gate.outcomes, [{ ok: true, rest: "echo first\n" }]);
});

test("the token may arrive in pieces and with a carriage return", async (t) => {
  const token = createRelayToken();
  const gate = await startGate(token);
  t.after(gate.close);

  const socket = await connect(gate.port);
  socket.write(token.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.write(`${token.slice(10)}\r\n`);
  assert.equal(await nextData(socket), "shell<>");
  socket.destroy();
});

test("a wrong token, an over-long line and a silent client are all turned away", async (t) => {
  const token = createRelayToken();
  const gate = await startGate(token, { timeoutMs: 80 });
  t.after(gate.close);

  const wrong = await connect(gate.port);
  wrong.write(`${createRelayToken()}\nwhoami\n`);
  await closed(wrong);

  const long = await connect(gate.port);
  long.on("error", () => {});
  long.write("x".repeat(TOKEN_MAX_BYTES + 1));
  await closed(long);

  const silent = await connect(gate.port);
  await closed(silent);

  assert.deepEqual(gate.outcomes, [
    { ok: false, error: "relay token rejected" },
    { ok: false, error: "relay token line too long" },
    { ok: false, error: "relay client did not present its token in time" },
  ]);
});

test("a client that leaves before the token is reported, not left pending", async (t) => {
  const token = createRelayToken();
  const gate = await startGate(token, { timeoutMs: 5000 });
  t.after(gate.close);

  const socket = await connect(gate.port);
  socket.destroy();
  for (let turn = 0; turn < 50 && gate.outcomes.length === 0; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(gate.outcomes, [{ ok: false, error: "relay client left before presenting its token" }]);
});
