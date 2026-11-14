"use strict";

// App side of the "as administrator" local terminal on Windows. Opens a named
// pipe, starts electron/elevatedPty/helper.cjs elevated through the normal
// UAC prompt, and returns an object with the node-pty surface terminalBridge
// uses (pid, onData, onExit, write, resize, clear, kill).

const net = require("node:net");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { spawn } = require("node:child_process");
const { FRAME, encodeFrame, encodeJsonFrame, createFrameDecoder, parseJsonPayload } = require("../../elevatedPty/protocol.cjs");

/** Time for the user to answer the UAC prompt and the helper to connect. */
const CONNECT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 20_000;

const ELEVATION_CANCELLED = "NETCATTY_ELEVATION_CANCELLED";
const ELEVATION_FAILED = "NETCATTY_ELEVATION_FAILED";

function elevationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** PowerShell single-quoted literal. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** The helper on disk: scripts run as node need a real path, not one inside app.asar. */
function resolveHelperPath() {
  const helper = path.join(__dirname, "..", "..", "elevatedPty", "helper.cjs");
  return helper.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

function windowsPowerShellPath(env = process.env) {
  // Absolute path: what gets elevated must not depend on PATH.
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The command that starts the helper elevated. The inner script is passed
 * base64-encoded so no path or token has to survive two layers of quoting.
 */
function buildElevationCommand({ execPath, helperPath, pipeName, token, env = process.env }) {
  const powershell = windowsPowerShellPath(env);
  const inner = [
    "$env:ELECTRON_RUN_AS_NODE='1'",
    `& ${psQuote(execPath)} ${psQuote(helperPath)} --pipe ${psQuote(pipeName)} --token ${psQuote(token)}`,
    "exit $LASTEXITCODE",
  ].join("; ");
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const innerArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded];
  // No semicolon between the try block and its catch: PowerShell would end
  // the statement there.
  const outer = "$ErrorActionPreference='Stop'; "
    + `try { Start-Process -FilePath ${psQuote(powershell)} -ArgumentList ${innerArgs.map(psQuote).join(",")} -Verb RunAs -WindowStyle Hidden } `
    + "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 5 }";
  return {
    file: powershell,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", outer],
    inner,
  };
}

function tokensMatch(expected, received) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Starts `shell` elevated. Resolves once the shell is running; rejects with
 * code NETCATTY_ELEVATION_CANCELLED when the user declines the UAC prompt.
 *
 * @param {{ shell: string, args?: string[], cols?: number, rows?: number, cwd?: string, env?: Record<string,string> }} request
 * @param {{ execPath?: string, helperPath?: string, launch?: Function, connectTimeoutMs?: number, pipeName?: string }} [deps]
 */
function spawnElevatedPty(request, deps = {}) {
  const pipeName = deps.pipeName || `\\\\.\\pipe\\netcatty-elevated-${randomBytes(16).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const execPath = deps.execPath || process.execPath;
  const helperPath = deps.helperPath || resolveHelperPath();
  const connectTimeoutMs = deps.connectTimeoutMs || CONNECT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let helperSocket = null;
    let exited = false;
    let pid = 0;
    const dataListeners = new Set();
    const exitListeners = new Set();
    let timer = null;

    const server = net.createServer();
    const closeServer = () => { try { server.close(); } catch { /* not listening */ } };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeServer();
      try { helperSocket?.destroy(); } catch { /* gone */ }
      reject(error);
    };

    const emitExit = (event) => {
      if (exited) return;
      exited = true;
      for (const listener of [...exitListeners]) {
        try { listener(event); } catch { /* listener errors are not ours */ }
      }
    };

    const ptyLike = {
      get pid() { return pid; },
      elevated: true,
      onData(listener) {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
      write(data) {
        if (exited || !helperSocket || helperSocket.destroyed) return;
        helperSocket.write(encodeFrame(FRAME.INPUT, data));
      },
      resize(cols, rows) {
        if (exited || !helperSocket || helperSocket.destroyed) return;
        helperSocket.write(encodeJsonFrame(FRAME.RESIZE, { cols, rows }));
      },
      clear() {
        if (exited || !helperSocket || helperSocket.destroyed) return;
        helperSocket.write(encodeFrame(FRAME.CLEAR));
      },
      kill() {
        if (!helperSocket || helperSocket.destroyed) return;
        helperSocket.write(encodeFrame(FRAME.KILL));
        // The helper ends the shell when the pipe closes, in case the frame is lost.
        setTimeout(() => { try { helperSocket.destroy(); } catch { /* gone */ } }, 1000).unref?.();
      },
    };

    const adopt = (socket) => {
      helperSocket = socket;
      // One helper per pipe: nothing else may connect from here on.
      closeServer();
      clearTimeout(timer);
      timer = setTimeout(() => fail(elevationError(ELEVATION_FAILED, "The elevated shell did not start")), READY_TIMEOUT_MS);
      socket.write(encodeJsonFrame(FRAME.SPAWN, {
        shell: request.shell,
        args: request.args || [],
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: request.env || {},
      }));
    };

    server.on("connection", (socket) => {
      let authenticated = false;
      const decoder = createFrameDecoder((type, payload) => {
        if (!authenticated) {
          // The first frame must be the token this launch handed to the helper.
          if (type !== FRAME.HELLO || helperSocket || !tokensMatch(token, payload.toString("utf8"))) {
            socket.destroy();
            return;
          }
          authenticated = true;
          adopt(socket);
          return;
        }
        if (type === FRAME.READY) {
          pid = Number(parseJsonPayload(payload).pid) || 0;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(ptyLike);
          }
        } else if (type === FRAME.OUTPUT) {
          const text = payload.toString("utf8");
          for (const listener of [...dataListeners]) {
            try { listener(text); } catch { /* listener errors are not ours */ }
          }
        } else if (type === FRAME.EXIT) {
          const event = parseJsonPayload(payload);
          emitExit({ exitCode: Number(event.exitCode) || 0, signal: event.signal });
          // The helper has nothing more to say; do not keep the pipe open.
          socket.end();
        } else if (type === FRAME.ERROR) {
          fail(elevationError(ELEVATION_FAILED, String(parseJsonPayload(payload).message || "The elevated shell failed to start")));
        }
      });
      socket.on("data", (chunk) => {
        try {
          decoder.push(chunk);
        } catch {
          socket.destroy();
        }
      });
      socket.on("error", () => { /* close follows */ });
      socket.on("close", () => {
        if (socket !== helperSocket) return;
        if (!settled) fail(elevationError(ELEVATION_FAILED, "The elevated helper closed before the shell started"));
        else emitExit({ exitCode: -1, signal: undefined });
      });
    });

    server.on("error", (error) => fail(elevationError(ELEVATION_FAILED, `Could not open the helper pipe: ${error.message}`)));

    server.listen(pipeName, () => {
      timer = setTimeout(
        () => fail(elevationError(ELEVATION_FAILED, "Timed out waiting for the elevated helper")),
        connectTimeoutMs,
      );
      const command = buildElevationCommand({ execPath, helperPath, pipeName, token });
      const launch = deps.launch || ((file, args) => spawn(file, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }));
      let launcher;
      try {
        launcher = launch(command.file, command.args, { ...command, pipeName, token });
      } catch (error) {
        fail(elevationError(ELEVATION_FAILED, `Could not ask for administrator rights: ${error.message}`));
        return;
      }
      let stderr = "";
      launcher.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
      launcher.on?.("error", (error) => fail(elevationError(ELEVATION_FAILED, `Could not ask for administrator rights: ${error.message}`)));
      launcher.on?.("exit", (code) => {
        if (code === 0 || settled) return;
        // Start-Process failed: almost always the user said no at the prompt.
        const cancelled = /cancel|取消|1223/i.test(stderr);
        fail(elevationError(
          cancelled ? ELEVATION_CANCELLED : ELEVATION_FAILED,
          cancelled ? "Administrator permission was not given" : `Could not start the elevated helper: ${stderr.trim() || `exit ${code}`}`,
        ));
      });
    });
  });
}

module.exports = {
  spawnElevatedPty,
  buildElevationCommand,
  resolveHelperPath,
  windowsPowerShellPath,
  ELEVATION_CANCELLED,
  ELEVATION_FAILED,
};
