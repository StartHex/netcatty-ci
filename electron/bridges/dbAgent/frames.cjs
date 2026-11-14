"use strict";

/**
 * Wire format shared with the on-host agent (agent/netcatty_dbagent.py).
 *
 * One frame per line, in both directions:
 *
 *   @NCQ@ <id> + <chunk>                 request, more chunks follow
 *   @NCQ@ <id> <METHOD> <crc> <chunk>    request, last chunk
 *   @NC@ <id> + <chunk>                  response, more chunks follow
 *   @NC@ <id> <KIND> <crc> <chunk>       response, last chunk
 *
 * The chunks of a frame concatenate to base64(zlib(JSON)); <crc> is the
 * CRC-32 of that base64 text. The stream is a terminal session, so it also
 * carries prompts, echoes and whatever the database libraries print: every
 * line that is not a frame is noise and is ignored.
 *
 * Lines stay short because a terminal in line mode drops input past 4095
 * bytes, and only base64 characters are used so no terminal treats any of
 * it as a control character.
 */

const zlib = require("node:zlib");

const REQUEST_MARK = "@NCQ@";
const RESPONSE_MARK = "@NC@";
const CHUNK_CHARS = 900;
const MAX_LINE_CHARS = 64 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(text) {
  let crc = 0xffffffff;
  for (let index = 0; index < text.length; index += 1) {
    crc = CRC_TABLE[(crc ^ text.charCodeAt(index)) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/** Lines (each ending in "\n") that carry one frame. */
function encodeFrame(mark, id, kind, payload) {
  const text = zlib.deflateSync(Buffer.from(JSON.stringify(payload ?? {}), "utf8")).toString("base64");
  const head = `${mark} ${id} `;
  const lines = [];
  let position = 0;
  while (text.length - position > CHUNK_CHARS) {
    lines.push(`${head}+ ${text.slice(position, position + CHUNK_CHARS)}\n`);
    position += CHUNK_CHARS;
  }
  lines.push(`${head}${kind} ${crc32(text)} ${text.slice(position)}\n`);
  return lines;
}

/**
 * Finds frames in lines of terminal output. `feed(line)` returns
 *   null                                  not a frame (or not complete yet)
 *   { id, kind, payload }                 a complete frame
 *   { id, error }                         a frame that arrived damaged
 */
class FrameDecoder {
  constructor(mark) {
    this.pattern = new RegExp(
      `${mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+) (?:(\\+) ([A-Za-z0-9+/=]+)|([A-Z]+) ([0-9a-fA-F]{8}) ([A-Za-z0-9+/=]+))`,
    );
    this.partial = new Map();
  }

  feed(line) {
    const match = this.pattern.exec(line);
    if (!match) return null;
    const id = Number(match[1]);
    if (match[2]) {
      const chunks = this.partial.get(id) ?? [];
      chunks.push(match[3]);
      this.partial.set(id, chunks);
      return null;
    }
    const chunks = this.partial.get(id) ?? [];
    this.partial.delete(id);
    chunks.push(match[6]);
    const text = chunks.join("");
    if (crc32(text) !== match[5].toLowerCase()) {
      return { id, error: "A frame from the host arrived damaged (checksum mismatch)" };
    }
    try {
      const payload = JSON.parse(zlib.inflateSync(Buffer.from(text, "base64")).toString("utf8"));
      return { id, kind: match[4], payload };
    } catch (error) {
      return { id, error: `A frame from the host could not be decoded: ${error.message}` };
    }
  }
}

/** Splits a byte stream into lines; "\r\n" and "\n" both end a line. */
class LineSplitter {
  constructor() {
    this.pending = "";
  }

  /** Returns the complete lines in `chunk`, without their line endings. */
  push(chunk) {
    // latin1 keeps every byte: frames are ASCII and noise is only displayed.
    this.pending += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
    const lines = [];
    for (;;) {
      const cut = this.pending.indexOf("\n");
      if (cut < 0) break;
      let line = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
    }
    if (this.pending.length > MAX_LINE_CHARS) {
      // A runaway line without an end cannot be a frame.
      lines.push(this.pending);
      this.pending = "";
    }
    return lines;
  }

  /** Text received after the last line end (a prompt waiting for input). */
  get tail() {
    return this.pending;
  }
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Removes escape sequences and control characters a terminal would act on. */
function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "");
}

module.exports = {
  REQUEST_MARK,
  RESPONSE_MARK,
  CHUNK_CHARS,
  crc32,
  encodeFrame,
  FrameDecoder,
  LineSplitter,
  stripAnsi,
};
