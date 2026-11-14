"use strict";

/**
 * Test support for the on-host database driver: an "SSH host" made of a
 * pseudo-terminal running an interactive shell, reached through a loopback
 * port guarded by a token - the same shape the port-forwarding bridge hands
 * to the driver - plus the test-double database libraries.
 */

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HERE = __dirname;

function has(program) {
  return spawnSync("sh", ["-c", `command -v ${program}`], { stdio: "ignore" }).status === 0;
}

/** Why the end-to-end tests cannot run here, or null when they can. */
function unavailableReason() {
  // The fake host is a Linux one: util-linux `script` for the terminal, ELF
  // shared objects for the client libraries - which is what the driver's
  // hosts are. Elsewhere the tests are skipped, not failed.
  if (process.platform !== "linux") return "needs a Linux host";
  for (const program of ["script", "python3", "cc", "bash"]) {
    if (!has(program)) return `needs ${program}`;
  }
  return null;
}

let fakesRoot = null;

/** Builds the test-double libraries once per process. */
function buildFakes() {
  if (fakesRoot) return fakesRoot;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nc-onhost-"));
  const built = spawnSync("sh", [path.join(HERE, "build_fakes.sh"), root], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`build_fakes.sh failed:\n${built.stderr}`);
  fakesRoot = root;
  process.once("exit", () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return root;
}

/** Environment of a host that has the libraries installed. */
function hostEnv(root, { dsci = "dsci", mdb = true, ddci = true } = {}) {
  const libs = [];
  const env = { ...process.env, LANG: "en_US.UTF-8" };
  for (const name of ["DSCI_PATH", "DCI_HOME", "LD_LIBRARY_PATH", "NLS_LANG", "LC_ALL"]) delete env[name];
  if (mdb) {
    env.DCI_HOME = path.join(root, "mdb");
    libs.push(path.join(root, "mdb", "dci", "lib"));
  }
  if (ddci) libs.push(path.join(root, "ddci", "lib"));
  if (dsci) {
    env.DSCI_PATH = path.join(root, dsci);
    libs.push(path.join(root, dsci, "lib"));
  }
  env.LD_LIBRARY_PATH = libs.join(":");
  return env;
}

/**
 * Starts the fake host. Every connection that presents the token gets its
 * own pseudo-terminal running `command` (an interactive shell by default).
 */
function startHost({ env, command = "bash --noprofile --norc -i", token = "test-token" } = {}) {
  const children = new Set();
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const cut = head.indexOf(0x0a);
      if (cut < 0) return;
      socket.off("data", onHead);
      if (head.subarray(0, cut).toString("latin1").trim() !== token) {
        socket.destroy();
        return;
      }
      const child = spawn("script", ["-qfc", command, "/dev/null"], { env, stdio: ["pipe", "pipe", "ignore"] });
      children.add(child);
      const rest = head.subarray(cut + 1);
      if (rest.length) child.stdin.write(rest);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      child.stdin.on("error", () => {});
      socket.on("error", () => {});
      const end = () => {
        children.delete(child);
        try {
          // Ending `script` closes the terminal, which hangs up everything
          // in it - what sshd does when the channel goes away. (Asked
          // politely, `script` waits for a shell that ignores the request.)
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        socket.destroy();
      };
      socket.once("close", end);
      child.once("exit", () => {
        children.delete(child);
        socket.destroy();
      });
    };
    socket.on("data", onHead);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        token,
        sessions: () => children.size,
        close: () => new Promise((done) => {
          for (const child of children) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
          server.close(() => done());
        }),
      });
    });
  });
}

/** Connection target as the renderer builds it once the relay is open. */
function targetFor(host, onHost = {}, extra = {}) {
  return {
    id: "conn-1",
    kind: "onhost",
    host: "127.0.0.1",
    port: host.port,
    username: "app",
    password: "secret",
    onHost: { mode: "config", relayToken: host.token, ...onHost },
    ...extra,
  };
}

module.exports = { buildFakes, hostEnv, startHost, targetFor, unavailableReason, HERE };
