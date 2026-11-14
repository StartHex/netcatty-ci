"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { FRAME, encodeFrame, encodeJsonFrame, createFrameDecoder, parseJsonPayload, MAX_FRAME_BYTES } = require("../../elevatedPty/protocol.cjs");
const { spawnElevatedPty, buildElevationCommand, ELEVATION_CANCELLED, ELEVATION_FAILED } = require("./elevatedLocalPty.cjs");

const testPipe = () => (process.platform === "win32"
  ? `\\\\.\\pipe\\netcatty-elevated-test-${process.pid}-${Math.random().toString(16).slice(2)}`
  : path.join(os.tmpdir(), `netcatty-elevated-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`));

/** Stands in for the elevated helper: echoes input back as output. */
function fakeHelper({ pipeName, token }, script = {}) {
  const launcher = new EventEmitter();
  const seen = { spawn: null, frames: [] };
  setImmediate(() => {
    launcher.emit("exit", 0);
    const socket = net.connect(pipeName);
    seen.socket = socket;
    const decoder = createFrameDecoder((type, payload) => {
      seen.frames.push(type);
      if (type === FRAME.SPAWN) {
        seen.spawn = parseJsonPayload(payload);
        if (script.failSpawn) {
          socket.write(encodeJsonFrame(FRAME.ERROR, { message: "shell not found" }));
          return;
        }
        socket.write(encodeJsonFrame(FRAME.READY, { pid: 4242 }));
        socket.write(encodeFrame(FRAME.OUTPUT, "prompt> "));
      } else if (type === FRAME.INPUT) {
        const text = payload.toString("utf8");
        if (text === "exit\r") socket.write(encodeJsonFrame(FRAME.EXIT, { exitCode: 7 }));
        else socket.write(encodeFrame(FRAME.OUTPUT, `echo:${text}`));
      } else if (type === FRAME.RESIZE) {
        seen.resize = parseJsonPayload(payload);
      } else if (type === FRAME.KILL) {
        socket.end();
      }
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("connect", () => socket.write(encodeFrame(FRAME.HELLO, script.wrongToken ? "0".repeat(64) : token)));
    socket.on("error", () => {});
  });
  return { launcher, seen };
}

test("frames survive arbitrary chunking and oversized frames are refused", () => {
  const frames = [];
  const decoder = createFrameDecoder((type, payload) => frames.push([type, payload.toString("utf8")]));
  const bytes = Buffer.concat([
    encodeFrame(FRAME.OUTPUT, "héllo 你好"),
    encodeJsonFrame(FRAME.RESIZE, { cols: 120, rows: 40 }),
    encodeFrame(FRAME.CLEAR),
  ]);
  for (let index = 0; index < bytes.length; index += 3) decoder.push(bytes.subarray(index, index + 3));
  assert.deepEqual(frames, [
    [FRAME.OUTPUT, "héllo 你好"],
    [FRAME.RESIZE, '{"cols":120,"rows":40}'],
    [FRAME.CLEAR, ""],
  ]);
  const header = Buffer.alloc(5);
  header.writeUInt8(FRAME.OUTPUT, 0);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
  assert.throws(() => createFrameDecoder(() => {}).push(header), /exceeds the limit/);
});

test("the elevation command elevates an absolute PowerShell and carries no bare paths", () => {
  const command = buildElevationCommand({
    execPath: "C:\\Program Files\\Netcatty\\Netcatty.exe",
    helperPath: "C:\\Program Files\\Netcatty\\resources\\app.asar.unpacked\\electron\\elevatedPty\\helper.cjs",
    pipeName: "\\\\.\\pipe\\netcatty-elevated-" + "a".repeat(32),
    token: "b".repeat(64),
    env: { SystemRoot: "C:\\Windows" },
  });
  assert.equal(command.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const outer = command.args.at(-1);
  assert.match(outer, /Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe'/);
  assert.match(outer, /-Verb RunAs/);
  assert.match(outer, /-WindowStyle Hidden \} catch \{/, "try and catch are one statement");
  // The token and the paths travel only inside the encoded script.
  assert.doesNotMatch(outer, /bbbbbbbb/);
  assert.doesNotMatch(outer, /Program Files/);
  const encoded = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), command.inner);
  assert.match(command.inner, /^\$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Netcatty\\Netcatty\.exe' '.*helper\.cjs' --pipe '.*' --token 'b{64}'; exit \$LASTEXITCODE$/);
});

test("a path with a quote cannot break out of the elevated script", () => {
  const command = buildElevationCommand({
    execPath: "C:\\Users\\O'Brien\\Netcatty.exe",
    helperPath: "C:\\x\\helper.cjs",
    pipeName: "p",
    token: "t",
    env: { SystemRoot: "C:\\Windows" },
  });
  assert.match(command.inner, /& 'C:\\Users\\O''Brien\\Netcatty\.exe' /);
});

test("relays output, input, resize and the exit code", async () => {
  let helper;
  const proc = await spawnElevatedPty(
    { shell: "cmd.exe", args: ["/k"], cols: 100, rows: 30, cwd: "C:\\", env: { TERM: "xterm-256color" } },
    { pipeName: testPipe(), launch: (_file, _args, command) => { helper = fakeHelper(command); return helper.launcher; } },
  );
  assert.equal(proc.pid, 4242);
  assert.deepEqual(helper.seen.spawn, { shell: "cmd.exe", args: ["/k"], cols: 100, rows: 30, cwd: "C:\\", env: { TERM: "xterm-256color" } });

  const output = [];
  proc.onData((text) => output.push(text));
  const exit = new Promise((resolve) => proc.onExit(resolve));
  proc.write("dir\r");
  proc.resize(120, 40);
  proc.write("exit\r");
  assert.deepEqual(await exit, { exitCode: 7, signal: undefined });
  assert.ok(output.join("").includes("echo:dir\r"));
  assert.deepEqual(helper.seen.resize, { cols: 120, rows: 40 });
});

test("kill ends the helper and reports an exit", async () => {
  let helper;
  const proc = await spawnElevatedPty(
    { shell: "cmd.exe" },
    { pipeName: testPipe(), launch: (_file, _args, command) => { helper = fakeHelper(command); return helper.launcher; } },
  );
  const exit = new Promise((resolve) => proc.onExit(resolve));
  proc.kill();
  assert.equal((await exit).exitCode, -1);
  assert.ok(helper.seen.frames.includes(FRAME.KILL));
});

test("declining the administrator prompt rejects as cancelled", async () => {
  const launch = () => {
    const launcher = new EventEmitter();
    launcher.stderr = new EventEmitter();
    setImmediate(() => {
      launcher.stderr.emit("data", Buffer.from("The operation was canceled by the user."));
      launcher.emit("exit", 5);
    });
    return launcher;
  };
  await assert.rejects(
    spawnElevatedPty({ shell: "cmd.exe" }, { pipeName: testPipe(), launch }),
    (error) => error.code === ELEVATION_CANCELLED,
  );
});

test("a connection without the right token is dropped and the launch times out", async () => {
  await assert.rejects(
    spawnElevatedPty(
      { shell: "cmd.exe" },
      { pipeName: testPipe(), connectTimeoutMs: 400, launch: (_file, _args, command) => fakeHelper(command, { wrongToken: true }).launcher },
    ),
    (error) => error.code === ELEVATION_FAILED && /Timed out/.test(error.message),
  );
});

test("a shell that cannot start is reported with its message", async () => {
  await assert.rejects(
    spawnElevatedPty(
      { shell: "nope.exe" },
      { pipeName: testPipe(), launch: (_file, _args, command) => fakeHelper(command, { failSpawn: true }).launcher },
    ),
    (error) => error.code === ELEVATION_FAILED && /shell not found/.test(error.message),
  );
});
