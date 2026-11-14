"use strict";

// Elevated terminal helper (Windows).
//
// Netcatty runs without administrator rights, and Windows does not let such a
// process start an elevated program inside its own pseudo-console. So for an
// "as administrator" local terminal, Netcatty starts this script elevated
// (the user approves the UAC prompt), and the script creates the
// pseudo-console and the shell on the elevated side and relays bytes over a
// named pipe that Netcatty opened beforehand.
//
// Started as:  <Netcatty.exe as node> helper.cjs --pipe <name> --token <hex>
// It runs exactly one shell, the one Netcatty asks for after the token
// matched, and exits when that shell or the pipe ends.

const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { FRAME, encodeFrame, encodeJsonFrame, createFrameDecoder, parseJsonPayload } = require("./protocol.cjs");

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

const pipeName = readArg("--pipe");
const token = readArg("--token");
// Only ever talk to a local named pipe: the name comes from the command line.
if (!/^\\\\\.\\pipe\\netcatty-elevated-[0-9a-f]{32}$/.test(pipeName) || !/^[0-9a-f]{64}$/.test(token)) {
  process.exit(64);
}

let proc = null;
let finished = false;

const socket = net.connect(pipeName);
const send = (frame) => {
  if (!socket.destroyed) socket.write(frame);
};

let shellExited = false;

/**
 * Ends the shell and everything it started. node-pty's own kill is
 * asynchronous on Windows and would be cut short by this process exiting,
 * which would leave an elevated shell running with no terminal attached.
 */
function endShell() {
  if (!proc || shellExited) return;
  const pid = proc.pid;
  try { proc.kill(); } catch { /* already gone */ }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    spawnSync(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    // Nothing more can be done from here.
  }
}

function finish(code) {
  if (finished) return;
  finished = true;
  endShell();
  socket.end(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}

function spawnShell(request) {
  if (proc) return;
  const shell = typeof request.shell === "string" ? request.shell : "";
  if (!shell) {
    send(encodeJsonFrame(FRAME.ERROR, { message: "No shell was given" }));
    finish(65);
    return;
  }
  const env = {};
  for (const [key, value] of Object.entries(request.env && typeof request.env === "object" ? request.env : {})) {
    if (typeof value === "string") env[key] = value;
  }
  try {
    const pty = require("node-pty");
    proc = pty.spawn(shell, Array.isArray(request.args) ? request.args.map(String) : [], {
      name: env.TERM || "xterm-256color",
      cols: Number.isInteger(request.cols) && request.cols > 0 ? request.cols : 80,
      rows: Number.isInteger(request.rows) && request.rows > 0 ? request.rows : 24,
      cwd: typeof request.cwd === "string" && request.cwd ? request.cwd : undefined,
      env: { ...process.env, ...env },
      useConptyDll: true,
    });
  } catch (error) {
    send(encodeJsonFrame(FRAME.ERROR, { message: String(error?.message || error) }));
    finish(66);
    return;
  }
  send(encodeJsonFrame(FRAME.READY, { pid: proc.pid }));
  proc.onData((data) => send(encodeFrame(FRAME.OUTPUT, data)));
  proc.onExit(({ exitCode, signal }) => {
    shellExited = true;
    send(encodeJsonFrame(FRAME.EXIT, { exitCode, signal }));
    finish(0);
  });
}

const decoder = createFrameDecoder((type, payload) => {
  if (type === FRAME.SPAWN) {
    spawnShell(parseJsonPayload(payload));
    return;
  }
  if (!proc) return;
  try {
    if (type === FRAME.INPUT) {
      proc.write(payload.toString("utf8"));
    } else if (type === FRAME.RESIZE) {
      const { cols, rows } = parseJsonPayload(payload);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) proc.resize(cols, rows);
    } else if (type === FRAME.CLEAR) {
      if (typeof proc.clear === "function") proc.clear();
    } else if (type === FRAME.KILL) {
      finish(0);
    }
  } catch {
    // The shell is going away; its exit event reports that.
  }
});

socket.on("connect", () => send(encodeFrame(FRAME.HELLO, token)));
socket.on("data", (chunk) => {
  try {
    decoder.push(chunk);
  } catch {
    finish(67);
  }
});
// Netcatty closed the tab or quit: never leave an elevated shell behind.
socket.on("close", () => finish(0));
socket.on("error", () => finish(68));
