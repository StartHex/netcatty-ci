"use strict";

/**
 * Gets the on-host agent running in a terminal session and talks to it.
 *
 * The stream is an interactive login shell on the SSH host (a PTY, exactly
 * what a terminal tab gets), possibly behind a bastion menu. Everything is
 * done by typing:
 *
 *   1. answer the bastion's prompts with the configured login steps
 *   2. find out that a shell is listening (echo a marker, wait for it)
 *   3. turn terminal echo off, run the optional environment command
 *   4. start Python with a one-line loader, type the agent into it
 *   5. exchange frames with the agent (frames.cjs)
 *
 * The shell prints an EXIT marker when Python returns, whatever the reason,
 * so a missing interpreter and an agent that ended are both noticed instead
 * of requests being typed into a shell prompt.
 *
 * Markers are typed with a quote in the middle (`__NC''RDY__`): the shell
 * prints them without it, so the terminal's echo of the command itself is
 * never mistaken for the command's output.
 */

const zlib = require("node:zlib");
const { EventEmitter } = require("node:events");
const {
  REQUEST_MARK,
  RESPONSE_MARK,
  encodeFrame,
  FrameDecoder,
  LineSplitter,
  stripAnsi,
} = require("./frames.cjs");

const DEFAULT_PYTHONS = ["python3", "python", "python2", "/usr/libexec/platform-python"];
const DEFAULT_STEP_TIMEOUT_MS = 30000;
const SHELL_SYNC_TIMEOUT_MS = 40000;
const SHELL_SYNC_RETRY_MS = 4000;
const ENV_TIMEOUT_MS = 30000;
const PYTHON_START_TIMEOUT_MS = 20000;
const AGENT_READY_TIMEOUT_MS = 30000;
const SCREEN_LIMIT = 64 * 1024;
const NOISE_LINES = 60;
const UPLOAD_LINE_CHARS = 76;

/**
 * Reads N bytes of base64 from the terminal and runs them. One line, no
 * single quotes, so it can sit inside '...' in any shell. The LOAD marker is
 * assembled at run time so the echoed command does not contain it.
 */
const PYTHON_LOADER = [
  "import os,sys,base64,zlib",
  "n=int(sys.argv[1])",
  'exec("def r(n):\\n d=b\\"\\"\\n while len(d)<n:\\n  c=os.read(0,n-len(d))\\n  if not c: break\\n  d+=c\\n return d")',
  'os.write(1,b"@NC"+b"@ 0 LOAD\\n")',
  's=r(n)',
  'exec(compile(zlib.decompress(base64.b64decode(s)),"netcatty_dbagent","exec"))',
].join(";");

const SAFE_PROGRAM = /^[A-Za-z0-9_.\/+-]+$/;
const AGENT_EXIT = /@NC@ 0 EXIT\b/;

function linkError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

/** Terminal bytes as text: UTF-8 when valid, otherwise GBK. */
function decodeHostText(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return buffer.toString("latin1");
    }
  }
}

/** "/pattern/flags" is a regular expression, anything else is plain text. */
function compileExpect(text) {
  const source = String(text ?? "");
  const match = /^\/(.+)\/([a-z]*)$/s.exec(source);
  if (match) {
    try {
      return new RegExp(match[1], match[2].replace(/[gy]/g, ""));
    } catch {
      /* not a valid expression: treat it as text */
    }
  }
  return source;
}

function findExpected(screen, expected) {
  if (typeof expected === "string") return expected === "" || screen.includes(expected);
  return expected.test(screen);
}

/** The agent, deflated and wrapped the way the loader reads it. */
function packAgent(source) {
  const encoded = zlib.deflateSync(Buffer.isBuffer(source) ? source : Buffer.from(String(source), "utf8"), {
    level: 9,
  }).toString("base64");
  const lines = [];
  for (let position = 0; position < encoded.length; position += UPLOAD_LINE_CHARS) {
    lines.push(encoded.slice(position, position + UPLOAD_LINE_CHARS));
  }
  const text = `${lines.join("\n")}\n`;
  return { text, bytes: Buffer.byteLength(text) };
}

function pythonCandidates(preferred) {
  const list = [];
  const first = typeof preferred === "string" ? preferred.trim() : "";
  if (first) {
    if (!SAFE_PROGRAM.test(first)) {
      throw linkError("onhost-no-python", `The Python path "${first}" may only contain letters, digits and . / _ + -`);
    }
    list.push(first);
  }
  for (const name of DEFAULT_PYTHONS) if (!list.includes(name)) list.push(name);
  return list;
}

class AgentLink extends EventEmitter {
  /**
   * @param stream duplex stream of the terminal session
   * @param options.agentSource  the agent's Python source (Buffer or string)
   * @param options.loginSteps   [{ expect, send, timeoutMs }] typed before the shell is reached
   * @param options.envCommand   shell command run before the agent starts
   * @param options.python       interpreter to try first
   */
  constructor(stream, options = {}) {
    super();
    this.stream = stream;
    this.options = options;
    this.splitter = new LineSplitter();
    this.decoder = new FrameDecoder(RESPONSE_MARK);
    this.pending = new Map();
    this.lastId = 0;
    this.noise = [];
    this.screen = Buffer.alloc(0);
    this.waiter = null;
    this.ready = null;
    this.closed = false;
    this.closeReason = null;
    this.identity = null;
    this.timeouts = {
      step: DEFAULT_STEP_TIMEOUT_MS,
      shellSync: SHELL_SYNC_TIMEOUT_MS,
      shellRetry: SHELL_SYNC_RETRY_MS,
      env: ENV_TIMEOUT_MS,
      pythonStart: PYTHON_START_TIMEOUT_MS,
      agentReady: AGENT_READY_TIMEOUT_MS,
      ...(options.timeouts ?? {}),
    };

    this.onData = (chunk) => this.receive(chunk);
    this.onEnd = () => this.finish(linkError("agent-exit", "The session to the host ended"));
    this.onError = (error) => this.finish(linkError("agent-exit", `The session to the host failed: ${error.message}`));
    stream.on("data", this.onData);
    stream.once("end", this.onEnd);
    stream.once("close", this.onEnd);
    stream.once("error", this.onError);
  }

  // ---------------------------------------------------------------- input

  receive(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "latin1");
    if (this.waiter) {
      this.screen = Buffer.concat([this.screen, buffer]);
      if (this.screen.length > SCREEN_LIMIT) this.screen = this.screen.subarray(this.screen.length - SCREEN_LIMIT);
    }
    for (const line of this.splitter.push(buffer)) this.receiveLine(line);
    this.checkWaiter();
  }

  receiveLine(line) {
    const frame = this.decoder.feed(line);
    if (!frame) {
      if (this.identity && AGENT_EXIT.test(line)) {
        // Python returned to the shell: nothing is listening for requests.
        this.close(linkError("agent-exit", "The agent on the host ended"));
        return;
      }
      if (!line.includes(`${RESPONSE_MARK} `)) this.remember(line);
      return;
    }
    if (frame.error) {
      this.finish(linkError("bad-frame", frame.error));
      return;
    }
    if (frame.kind === "READY") {
      this.identity = frame.payload;
      this.ready?.resolve(frame.payload);
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    if (frame.kind === "COLS") {
      entry.onColumns?.(frame.payload.columns ?? []);
    } else if (frame.kind === "ROWS") {
      entry.onRows?.(frame.payload.rows ?? []);
    } else if (frame.kind === "OK") {
      this.settle(frame.id, null, frame.payload);
    } else if (frame.kind === "ERR") {
      const error = linkError(frame.payload.code || "db-error", frame.payload.message || "Database error");
      if (typeof frame.payload.native === "number") error.native = frame.payload.native;
      if (Array.isArray(frame.payload.trace)) error.detail = frame.payload.trace.join("\n");
      this.settle(frame.id, error);
    }
  }

  remember(line) {
    const text = stripAnsi(decodeHostText(Buffer.from(line, "latin1"))).trimEnd();
    if (!text) return;
    this.noise.push(text.length > 400 ? `${text.slice(0, 400)}…` : text);
    if (this.noise.length > NOISE_LINES) this.noise.shift();
  }

  /** What the host printed lately, for error reports. */
  recentOutput(lines = 15) {
    const tail = stripAnsi(decodeHostText(Buffer.from(this.splitter.tail, "latin1"))).trim();
    const all = tail ? [...this.noise, tail] : this.noise;
    return all.slice(-lines).join("\n");
  }

  // ------------------------------------------------------------ expecting

  screenText() {
    return stripAnsi(decodeHostText(this.screen));
  }

  checkWaiter() {
    const waiter = this.waiter;
    if (!waiter) return;
    const hit = waiter.test(this.screenText());
    if (hit === null || hit === undefined || hit === false) return;
    this.waiter = null;
    clearTimeout(waiter.timer);
    // What was matched is consumed: the next wait only sees later output.
    this.screen = Buffer.alloc(0);
    waiter.resolve(hit);
  }

  /** Resolves with test(screen)'s first truthy result, or rejects on timeout / close. */
  waitScreen(test, timeoutMs, onTimeout) {
    if (this.closed) return Promise.reject(this.closeReason);
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (this.waiter !== waiter) return;
        this.waiter = null;
        reject(onTimeout());
      }, timeoutMs);
      this.waiter = waiter;
      this.checkWaiter();
    });
  }

  write(text) {
    if (this.closed) throw this.closeReason;
    this.stream.write(text);
  }

  // ------------------------------------------------------------ bootstrap

  async start() {
    try {
      await this.runLoginSteps();
      await this.reachShell();
      await this.runShellLine("stty -echo 2>/dev/null", this.timeouts.env, "onhost-no-shell");
      const envCommand = typeof this.options.envCommand === "string" ? this.options.envCommand.trim() : "";
      if (envCommand) {
        await this.runShellLine(envCommand.replace(/\r?\n/g, "; "), this.timeouts.env, "onhost-env");
      }
      return await this.startAgent();
    } catch (error) {
      if (error && !error.detail) {
        const output = this.recentOutput();
        if (output) error.detail = output;
      }
      this.close(error);
      throw error;
    }
  }

  async runLoginSteps() {
    const steps = Array.isArray(this.options.loginSteps) ? this.options.loginSteps : [];
    // The screen is recorded only while something waits for it.
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index] ?? {};
      const expected = compileExpect(step.expect);
      const timeoutMs = Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : this.timeouts.step;
      if (expected !== "") {
        await this.waitScreen(
          (screen) => findExpected(screen, expected),
          timeoutMs,
          () => linkError(
            "onhost-login-step",
            `Login step ${index + 1} timed out after ${Math.round(timeoutMs / 1000)}s waiting for "${step.expect}"`,
          ),
        );
      }
      if (typeof step.send === "string" && (step.send !== "" || step.enter !== false)) {
        // Menus read keys, so the line ends with the Enter key itself.
        this.write(step.enter === false ? step.send : `${step.send}\r`);
      }
    }
  }

  /** Types an echo until a shell answers it. */
  async reachShell() {
    const nonce = Math.random().toString(36).slice(2, 10);
    const deadline = Date.now() + this.timeouts.shellSync;
    const answer = new RegExp(`__NCRDY${nonce}_\\d+__`);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.write(`echo __NC''RDY${nonce}_${attempt}__\n`);
      const left = deadline - Date.now();
      const wait = Math.max(1, Math.min(this.timeouts.shellRetry, left));
      try {
        await this.waitScreen((screen) => answer.test(screen), wait, () => linkError("retry", "retry"));
        return;
      } catch (error) {
        if (error.code !== "retry") throw error;
        if (Date.now() >= deadline) {
          throw linkError(
            "onhost-no-shell",
            `No shell answered within ${Math.round(this.timeouts.shellSync / 1000)}s after logging in`,
          );
        }
      }
    }
  }

  async runShellLine(command, timeoutMs, code) {
    const tag = `DONE${Math.random().toString(36).slice(2, 10)}`;
    this.write(`${command}\n`);
    this.write(`echo __NC''${tag}__\n`);
    await this.waitScreen(
      (screen) => screen.includes(`__NC${tag}__`),
      timeoutMs,
      () => linkError(code, `The command did not finish within ${Math.round(timeoutMs / 1000)}s: ${command}`),
    );
  }

  async startAgent() {
    const packed = packAgent(this.options.agentSource);
    const failures = [];
    for (const python of pythonCandidates(this.options.python)) {
      this.ready = null;
      this.identity = null;
      this.write(`${python} -u -c '${PYTHON_LOADER}' ${packed.bytes}; echo @NC''@ 0 EXIT\n`);
      const started = await this.waitScreen(
        (screen) => /@NC@ 0 (LOAD|EXIT)/.exec(screen)?.[1],
        this.timeouts.pythonStart,
        () => linkError("onhost-no-python", `${python} did not start within ${Math.round(this.timeouts.pythonStart / 1000)}s`),
      );
      if (started === "EXIT") {
        failures.push(`${python}: not available`);
        continue;
      }
      const ready = new Promise((resolve, reject) => {
        this.ready = { resolve, reject };
      });
      this.write(packed.text);
      const outcome = await Promise.race([
        ready.then((identity) => ({ identity })),
        this.waitScreen(
          (screen) => AGENT_EXIT.test(screen),
          this.timeouts.agentReady,
          () => linkError("onhost-agent-start", `The agent did not start under ${python} within ${Math.round(this.timeouts.agentReady / 1000)}s`),
        ).then(() => ({ failed: true })),
      ]);
      if (outcome.identity) {
        this.cancelWaiter();
        return outcome.identity;
      }
      failures.push(`${python}: the agent stopped while starting`);
    }
    const noPython = failures.every((entry) => entry.endsWith("not available"));
    throw linkError(
      noPython ? "onhost-no-python" : "onhost-agent-start",
      noPython
        ? `No Python interpreter was found on the host (tried ${failures.map((entry) => entry.split(":")[0]).join(", ")})`
        : `The agent could not be started on the host (${failures.join("; ")})`,
    );
  }

  cancelWaiter() {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    this.waiter = null;
    this.screen = Buffer.alloc(0);
  }

  // -------------------------------------------------------------- requests

  /**
   * Sends one request. Resolves with the agent's OK payload; rejects with an
   * error carrying the agent's `code`. Row batches go to `onRows`.
   */
  request(method, params, handlers = {}) {
    if (this.closed) return Promise.reject(this.closeReason);
    this.lastId += 1;
    const id = this.lastId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onColumns: handlers.onColumns, onRows: handlers.onRows });
      try {
        for (const line of encodeFrame(REQUEST_MARK, id, method, params)) this.stream.write(line);
      } catch (error) {
        this.pending.delete(id);
        reject(linkError("agent-exit", `The session to the host failed: ${error.message}`));
      }
    });
  }

  settle(id, error, payload) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (error) entry.reject(error);
    else entry.resolve(payload ?? {});
  }

  get busy() {
    return this.pending.size > 0;
  }

  // ----------------------------------------------------------------- close

  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    const output = this.recentOutput();
    if (output && !reason.detail) reason.detail = output;
    this.closeReason = reason;
    this.stream.off("data", this.onData);
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(reason);
    }
    this.ready?.reject(reason);
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(reason);
    }
    this.emit("close", reason);
  }

  /** Ends the session; the agent exits when its terminal goes away. */
  close(reason) {
    this.finish(reason ?? linkError("agent-exit", "The connection was closed"));
    try {
      this.stream.destroy();
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  AgentLink,
  PYTHON_LOADER,
  DEFAULT_PYTHONS,
  compileExpect,
  decodeHostText,
  packAgent,
  pythonCandidates,
};
