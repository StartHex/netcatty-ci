"use strict";

/**
 * Local forwarding for SSH servers that refuse it.
 *
 * A local forward normally asks the SSH server to open the TCP connection
 * itself (a direct-tcpip channel). Hardened servers turn that off
 * (`AllowTcpForwarding no`) while still letting the user run commands. The
 * user can then reach the target from that host's shell — which is exactly
 * what the relay does: it runs a small command on the host that connects to
 * the target and copies bytes both ways over the command's stdin/stdout.
 */

const { openBoundedSshChannel } = require("./boundedSshChannelOpen.cjs");

const RELAY_OPEN_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 20000;
const MAX_STDERR_CHARS = 600;

/** Exit code of the relay's bash branch when /dev/tcp could not connect. */
const BASH_CONNECT_FAILED = 97;
/** Exit code when the host has no program that can relay. */
const NO_RELAY_PROGRAM = 98;

/** The target is pasted into a shell command, so only plain addresses pass. */
function isSafeRelayTarget(host, port) {
  const portNumber = Number(port);
  return typeof host === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(host)
    && Number.isInteger(portNumber)
    && portNumber > 0
    && portNumber < 65536;
}

/**
 * SSH channel-open failures that mean "this server will not forward", as
 * opposed to "the target refused". Reason 1 is administratively prohibited;
 * 3 is unknown channel type (bastions that never implemented forwarding).
 */
function isForwardProhibitedError(error) {
  if (!error) return false;
  if (error.reason === 1 || error.reason === 3) return true;
  if (error.reason === "ADMINISTRATIVELY_PROHIBITED" || error.reason === "UNKNOWN_CHANNEL_TYPE") return true;
  return /administratively prohibited|unknown channel type|forwarding (is )?disabled/i
    .test(String(error.message || error));
}

function assertSafeTarget(host, port) {
  if (!isSafeRelayTarget(host, port)) {
    throw new Error(`Cannot relay to ${host}:${port}: not a plain host name or address`);
  }
}

/**
 * The relay command. bash's /dev/tcp is tried first because its shutdown is
 * predictable: the command ends as soon as either side closes, so no process
 * is left holding the connection to the target. nc/ncat are the fallback for
 * hosts without bash or with /dev/tcp compiled out.
 *
 * How the bash branch ends:
 *  - target closes: the reader `cat` ends, `wait` returns and the command
 *    exits. The writer is left reading stdin, which the SSH server closes
 *    with the channel; it holds neither stdout nor stderr, so it cannot keep
 *    the channel open.
 *  - client closes: the writer `cat` sees end of input and kills the reader.
 * It works on bash 3 and 4 (no `wait -n`) and signals only its own children.
 *
 * The script contains no single quotes: it is passed as one `sh -c '...'`.
 */
function buildRelayCommand(host, port) {
  assertSafeTarget(host, port);
  const script = [
    `H=${host}; P=${Number(port)}`,
    "if command -v bash >/dev/null 2>&1; then",
    // fd 4 keeps the real stdin: a background job's stdin is /dev/null.
    // `\$` reaches bash as `$`; `$H`/`$P` are filled in by the outer sh.
    `  bash -c "exec 4<&0 3<>/dev/tcp/$H/$P || exit ${BASH_CONNECT_FAILED}; cat <&3 & R=\\$!; (cat <&4 >&3; kill \\$R) >/dev/null 2>&1 & wait \\$R; exit 0"`,
    `  [ $? -eq ${BASH_CONNECT_FAILED} ] || exit 0`,
    "fi",
    "if command -v nc >/dev/null 2>&1; then exec nc $H $P; fi",
    "if command -v ncat >/dev/null 2>&1; then exec ncat $H $P; fi",
    `echo "no bash, nc or ncat on this host to relay the connection" >&2; exit ${NO_RELAY_PROGRAM}`,
  ].join("\n");
  return `sh -c '${script}'`;
}

/** Exits 0 when the host can open a TCP connection to the target. */
function buildProbeCommand(host, port) {
  assertSafeTarget(host, port);
  const script = [
    `H=${host}; P=${Number(port)}; T=""`,
    "if command -v timeout >/dev/null 2>&1; then T=\"timeout 10\"; fi",
    "if command -v bash >/dev/null 2>&1; then",
    `  $T bash -c "exec 3<>/dev/tcp/$H/$P" && exit 0`,
    "fi",
    "if command -v nc >/dev/null 2>&1; then $T nc -z -w 8 $H $P && exit 0; fi",
    "exit 1",
  ].join("\n");
  return `sh -c '${script}'`;
}

function collectStderr(stream, sink) {
  const stderr = stream?.stderr;
  if (!stderr || typeof stderr.on !== "function") return;
  stderr.on("data", (chunk) => {
    if (sink.text.length >= MAX_STDERR_CHARS) return;
    sink.text = (sink.text + String(chunk)).slice(0, MAX_STDERR_CHARS);
  });
}

function execChannel(conn, command, options = {}) {
  return openBoundedSshChannel(
    conn,
    (callback) => conn.exec(command, callback),
    {
      label: options.label || "SSH relay command",
      timeoutMs: options.timeoutMs || RELAY_OPEN_TIMEOUT_MS,
      signal: options.signal || null,
      // A relay that fails to start must not take down a shared transport.
      invalidateOnAbort: false,
      invalidateOnTimeout: false,
    },
  );
}

/**
 * Opens a relay to the target. Calls back with a duplex stream that behaves
 * like a forwardOut channel; `stream.relayStderr()` returns what the command
 * printed, which is the reason when the stream closes right away.
 */
function openExecRelay(conn, host, port, callback, options = {}) {
  let command;
  try {
    command = buildRelayCommand(host, port);
  } catch (error) {
    callback(error);
    return;
  }
  execChannel(conn, command, options).then(
    (stream) => {
      const sink = { text: "" };
      collectStderr(stream, sink);
      stream.relayStderr = () => sink.text.trim();
      callback(null, stream);
    },
    (error) => callback(error),
  );
}

/** Resolves `{ ok, detail }`: can the host itself reach the target? */
function probeTargetFromHostShell(conn, host, port, options = {}) {
  let command;
  try {
    command = buildProbeCommand(host, port);
  } catch (error) {
    return Promise.resolve({ ok: false, detail: error.message });
  }
  const timeoutMs = options.timeoutMs || PROBE_TIMEOUT_MS;
  return execChannel(conn, command, { label: "SSH relay probe", timeoutMs }).then(
    (stream) => new Promise((resolve) => {
      const sink = { text: "" };
      collectStderr(stream, sink);
      let exitCode = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { stream.close?.(); } catch { /* ignore */ }
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, detail: "the connection attempt timed out" }),
        timeoutMs,
      );
      stream.on("exit", (code) => { exitCode = code; });
      stream.on("close", () => finish({
        ok: exitCode === 0,
        detail: sink.text.trim() || (exitCode === 0 ? "" : "the connection was refused or timed out"),
      }));
      stream.on("error", (error) => finish({ ok: false, detail: error.message }));
      // The probe prints nothing useful on stdout, but it must be drained.
      stream.on("data", () => {});
    }),
    (error) => ({ ok: false, detail: error.message }),
  );
}

function describeChannelError(error) {
  return String(error?.message || error || "unknown error").replace(/^\(SSH\)\s*/, "");
}

/**
 * Checks, before a tunnel is reported as ready, that the SSH host can really
 * reach the target, so the caller gets the reason instead of a connection
 * that is dropped the moment it is used.
 *
 * Resolves `{ execRelay }` (true when forwarding is refused but the relay
 * works) and rejects with a message that names the target and the reason.
 */
async function verifyForwardTarget({ conn, openForwardOut, host, port, closeChannel }) {
  let forwardError;
  try {
    const stream = await openForwardOut();
    try { (closeChannel || ((channel) => channel?.close?.()))(stream); } catch { /* ignore */ }
    return { execRelay: false };
  } catch (error) {
    forwardError = error;
  }
  if (!isForwardProhibitedError(forwardError)) {
    throw new Error(`the SSH host could not connect to ${host}:${port} (${describeChannelError(forwardError)})`);
  }
  if (!isSafeRelayTarget(host, port)) {
    throw new Error(`the SSH host does not allow port forwarding (${describeChannelError(forwardError)})`);
  }
  const probe = await probeTargetFromHostShell(conn, host, port);
  if (probe.ok) return { execRelay: true };
  throw new Error(
    `the SSH host does not allow port forwarding, and could not connect to ${host}:${port} from its shell either`
    + (probe.detail ? ` (${probe.detail})` : ""),
  );
}

module.exports = {
  verifyForwardTarget,
  BASH_CONNECT_FAILED,
  NO_RELAY_PROGRAM,
  isSafeRelayTarget,
  isForwardProhibitedError,
  buildRelayCommand,
  buildProbeCommand,
  openExecRelay,
  probeTargetFromHostShell,
};
