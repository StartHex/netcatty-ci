"use strict";

/**
 * Anti-idle input for interactive SSH shells.
 *
 * SSH keepalive packets keep the transport (and NAT state) alive, but they are
 * invisible to the remote shell. A server that logs idle users out — bash
 * `TMOUT`, a bastion's idle policy — only resets its timer on real terminal
 * input. When a host opts in, the configured text is typed into the shell
 * whenever the session has seen no input and no output for the interval.
 */

const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 86400;
const MAX_TEXT_LENGTH = 64;
const DEFAULT_TEXT = "\\n";

/** Turns `\n`, `\r`, `\t`, `\e`, `\\`, `\xNN` escapes into the bytes to send. */
function decodeAntiIdleText(text) {
  const source = typeof text === "string" && text.length > 0 ? text : DEFAULT_TEXT;
  const decoded = source.slice(0, MAX_TEXT_LENGTH).replace(
    /\\(x[0-9a-fA-F]{2}|[nrte\\])/g,
    (_match, code) => {
      if (code === "n") return "\n";
      if (code === "r") return "\r";
      if (code === "t") return "\t";
      if (code === "e") return "\x1b";
      if (code === "\\") return "\\";
      return String.fromCharCode(parseInt(code.slice(1), 16));
    },
  );
  return decoded.length > 0 ? decoded : "\n";
}

/** Returns `{ intervalMs, data }`, or null when the host did not opt in. */
function resolveAntiIdlePolicy(options = {}) {
  const seconds = Number(options.antiIdleIntervalSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const clamped = Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.trunc(seconds)));
  return { intervalMs: clamped * 1000, data: decodeAntiIdleText(options.antiIdleText) };
}

/**
 * Starts the idle watcher. `session.lastActivityAt` is refreshed by the
 * terminal input path and by shell output; this only reads it.
 *
 * `isAlive()` false stops the watcher for good, so callers need no teardown.
 */
function startAntiIdle({
  session,
  policy,
  send,
  isAlive,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  if (!policy) return () => {};
  session.lastActivityAt = now();
  const tickMs = Math.min(15000, Math.max(1000, Math.floor(policy.intervalMs / 4)));
  let timer = null;
  const stop = () => {
    if (timer == null) return;
    clearIntervalFn(timer);
    timer = null;
  };
  timer = setIntervalFn(() => {
    if (!isAlive()) {
      stop();
      return;
    }
    const idleFor = now() - (session.lastActivityAt || 0);
    if (idleFor < policy.intervalMs) return;
    session.lastActivityAt = now();
    try {
      send(policy.data);
    } catch {
      stop();
    }
  }, tickMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return stop;
}

module.exports = {
  decodeAntiIdleText,
  resolveAntiIdlePolicy,
  startAntiIdle,
};
