"use strict";

/**
 * A local forward whose far end is the SSH host's login shell instead of a TCP
 * port: every connection to the local port gets a fresh terminal on the host.
 *
 * The on-host database driver needs exactly that. It logs in (through a
 * bastion's host picker when there is one), starts its agent on the host and
 * talks to it over the terminal. Everything about reaching the host - keys,
 * jump hosts, one-time codes, host key checks - is what a port forward already
 * does, so the driver asks for a forward and is handed a local port.
 *
 * A shell is a far bigger thing to leave on a loopback port than a database
 * socket, since any local process can connect to it. A client therefore has to
 * present the tunnel's one-time token as its first line before a shell is
 * opened for it.
 */

const crypto = require("node:crypto");

/** Wide enough that the lines the driver types are not wrapped by the terminal. */
const RELAY_PTY = Object.freeze({ term: "xterm", cols: 200, rows: 50 });
const TOKEN_TIMEOUT_MS = 5000;
/** A token is 48 characters; anything much longer is not a client of ours. */
const TOKEN_MAX_BYTES = 256;

function createRelayToken() {
  return crypto.randomBytes(24).toString("hex");
}

function tokensMatch(presented, expected) {
  const left = Buffer.from(String(presented ?? ""), "latin1");
  const right = Buffer.from(String(expected ?? ""), "latin1");
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Waits for the client's token line.
 *
 * Resolves with the bytes that followed the line in the same read (they are
 * already meant for the shell) and leaves the socket paused, so nothing is
 * lost before it is piped. Rejects on a wrong token, an over-long line, a
 * timeout, or when the client leaves first.
 */
function authorizeRelayClient(socket, token, { timeoutMs = TOKEN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer = null;
    const settle = (error, rest) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onGone);
      socket.removeListener("error", onGone);
      try { socket.pause(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(rest);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      const newline = all.indexOf(0x0a);
      if (newline === -1) {
        if (size > TOKEN_MAX_BYTES) settle(new Error("relay token line too long"));
        return;
      }
      const line = all.subarray(0, newline).toString("latin1").replace(/\r$/, "");
      if (!tokensMatch(line, token)) {
        settle(new Error("relay token rejected"));
        return;
      }
      settle(null, all.subarray(newline + 1));
    };
    const onGone = () => settle(new Error("relay client left before presenting its token"));
    timer = setTimeout(
      () => settle(new Error("relay client did not present its token in time")),
      timeoutMs,
    );
    socket.on("data", onData);
    socket.once("close", onGone);
    socket.once("error", onGone);
  });
}

module.exports = {
  RELAY_PTY,
  TOKEN_MAX_BYTES,
  authorizeRelayClient,
  createRelayToken,
  tokensMatch,
};
