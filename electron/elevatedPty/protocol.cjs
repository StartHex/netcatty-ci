"use strict";

// Wire format between Netcatty and the elevated terminal helper.
// Every frame is: 1 byte type, 4 bytes big-endian payload length, payload.

const FRAME = Object.freeze({
  HELLO: 1, // helper -> app   utf-8 token
  SPAWN: 2, // app -> helper   json { shell, args, cols, rows, cwd, env }
  READY: 3, // helper -> app   json { pid }
  OUTPUT: 4, // helper -> app  terminal output, utf-8
  INPUT: 5, // app -> helper   keystrokes, utf-8
  RESIZE: 6, // app -> helper  json { cols, rows }
  CLEAR: 7, // app -> helper   clear the ConPTY screen buffer
  KILL: 8, // app -> helper    end the shell
  EXIT: 9, // helper -> app    json { exitCode, signal }
  ERROR: 10, // helper -> app  json { message }
});

const HEADER_BYTES = 5;
/** Largest payload accepted. Anything bigger means the stream is corrupt. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function encodeFrame(type, payload) {
  const body = payload === undefined || payload === null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

const encodeJsonFrame = (type, value) => encodeFrame(type, JSON.stringify(value));

/**
 * Turns a byte stream into frames. Feed it chunks with push(); onFrame gets
 * (type, payload) for every complete frame. Throws on an oversized frame.
 */
function createFrameDecoder(onFrame) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < HEADER_BYTES) return;
        const length = pending.readUInt32BE(1);
        if (length > MAX_FRAME_BYTES) throw new Error(`Frame of ${length} bytes exceeds the limit`);
        const end = HEADER_BYTES + length;
        if (pending.length < end) return;
        const type = pending.readUInt8(0);
        const payload = pending.subarray(HEADER_BYTES, end);
        pending = pending.subarray(end);
        onFrame(type, payload);
      }
    },
  };
}

function parseJsonPayload(payload) {
  try {
    const value = JSON.parse(payload.toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

module.exports = { FRAME, MAX_FRAME_BYTES, encodeFrame, encodeJsonFrame, createFrameDecoder, parseJsonPayload };
