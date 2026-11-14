const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const net = require("node:net");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  _bindPortForwardChannelsForTests: bindPortForwardChannels,
  _clearPortForwardTunnelsForTests: clearPortForwardTunnels,
  cancelTunnel,
} = require("./portForwardingBridge.cjs");

/** An SSH connection whose shells echo what is typed into them. */
function fakeHost() {
  const shells = [];
  const conn = new EventEmitter();
  conn.shell = (windowOptions, shellOptions, callback) => {
    const stream = new PassThrough();
    stream.windowOptions = windowOptions;
    shells.push(stream);
    callback(null, stream);
  };
  conn.forwardOut = () => {
    throw new Error("a shell relay must not forward a port");
  };
  conn.exec = () => {
    throw new Error("a shell relay must not run a relay command");
  };
  conn.end = () => {};
  conn.destroy = () => {};
  return { conn, shells };
}

async function startRelay(conn, tunnelId) {
  const tunnel = {
    tunnelId,
    cancelled: false,
    activePipes: new Set(),
    chainConnections: [],
    sshTransportManaged: false,
    shellRelay: { token: "relay-token-for-tests" },
    // Even when asked for, there is no target to verify for a shell.
    verifyRemote: true,
  };
  const started = await bindPortForwardChannels({
    type: "local",
    conn,
    tunnelId,
    tunnelState: tunnel,
    sender: { id: 41, isDestroyed: () => false },
    bindAddress: "127.0.0.1",
    localPort: 0,
    remoteHost: undefined,
    remotePort: undefined,
    chainConnections: [],
    sendStatus() {},
  });
  return { tunnel, started };
}

test("a shell relay reports its port and token, and opens a terminal for a client that presents it", async () => {
  const { conn, shells } = fakeHost();
  const { tunnel, started } = await startRelay(conn, "pf-shell-relay");
  try {
    assert.equal(started.success, true);
    assert.equal(started.relayToken, "relay-token-for-tests");
    assert.equal(started.localPort, tunnel.server.address().port);

    const client = net.connect(started.localPort, "127.0.0.1");
    await once(client, "connect");
    // The first command rides in the same packet as the token.
    client.write("relay-token-for-tests\necho ready\n");
    const [echoed] = await once(client, "data");
    assert.equal(echoed.toString(), "echo ready\n", "everything after the token line reaches the shell");
    assert.equal(shells.length, 1);
    assert.deepEqual({ ...shells[0].windowOptions }, { term: "xterm", cols: 200, rows: 50 });

    client.write("second line\n");
    const [again] = await once(client, "data");
    assert.equal(again.toString(), "second line\n");
    client.destroy();
    await once(client, "close");
  } finally {
    await cancelTunnel(tunnel.tunnelId, tunnel, () => {});
    clearPortForwardTunnels();
  }
});

test("a client without the token gets no terminal on the host", async () => {
  const { conn, shells } = fakeHost();
  const { tunnel, started } = await startRelay(conn, "pf-shell-relay-refused");
  try {
    const intruder = net.connect(started.localPort, "127.0.0.1");
    intruder.on("error", () => {});
    await once(intruder, "connect");
    intruder.write("not-the-token\nwhoami\n");
    await once(intruder, "close");
    assert.equal(shells.length, 0, "no shell was opened");
    assert.equal(tunnel.activePipes.size, 0, "and the refused client is not kept around");

    // The listener keeps serving the real client afterwards.
    const client = net.connect(started.localPort, "127.0.0.1");
    await once(client, "connect");
    client.write("relay-token-for-tests\n");
    client.write("hello\n");
    const [echoed] = await once(client, "data");
    assert.equal(echoed.toString(), "hello\n");
    assert.equal(shells.length, 1);
    client.destroy();
    await once(client, "close");
  } finally {
    await cancelTunnel(tunnel.tunnelId, tunnel, () => {});
    clearPortForwardTunnels();
  }
});

test("an ordinary local forward reports no relay token", async () => {
  let finishForwardOut;
  const conn = new EventEmitter();
  conn.forwardOut = (_sourceAddress, _sourcePort, _targetAddress, _targetPort, callback) => {
    finishForwardOut = callback;
  };
  conn.end = () => {};
  conn.destroy = () => {};
  const tunnel = {
    tunnelId: "pf-plain-forward",
    cancelled: false,
    activePipes: new Set(),
    chainConnections: [],
    sshTransportManaged: false,
  };
  try {
    const started = await bindPortForwardChannels({
      type: "local",
      conn,
      tunnelId: tunnel.tunnelId,
      tunnelState: tunnel,
      sender: { id: 42, isDestroyed: () => false },
      bindAddress: "127.0.0.1",
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 5432,
      chainConnections: [],
      sendStatus() {},
    });
    assert.equal(started.success, true);
    assert.equal("relayToken" in started, false);

    // No token is asked of its clients either: the forward opens at once.
    const client = net.connect(started.localPort, "127.0.0.1");
    await once(client, "connect");
    for (let turn = 0; turn < 50 && !finishForwardOut; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(typeof finishForwardOut, "function");
    client.destroy();
    await once(client, "close");
    finishForwardOut(new Error("client closed"));
  } finally {
    await cancelTunnel(tunnel.tunnelId, tunnel, () => {});
    clearPortForwardTunnels();
  }
});
