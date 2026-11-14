const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  REQUEST_MARK,
  RESPONSE_MARK,
  CHUNK_CHARS,
  crc32,
  encodeFrame,
  FrameDecoder,
  LineSplitter,
  stripAnsi,
} = require("./frames.cjs");

test("crc32 matches the standard check value", () => {
  assert.equal(crc32("123456789"), "cbf43926");
  assert.equal(crc32(""), "00000000");
});

test("a frame survives the trip, however many lines it needs", () => {
  const decoder = new FrameDecoder(RESPONSE_MARK);
  const small = encodeFrame(RESPONSE_MARK, 7, "OK", { rows: 3, text: "中文 ✓" });
  assert.equal(small.length, 1);
  assert.deepEqual(decoder.feed(small[0].trimEnd()), { id: 7, kind: "OK", payload: { rows: 3, text: "中文 ✓" } });

  // Random text does not compress, so this needs several lines.
  const noise = crypto.randomBytes(3000).toString("hex");
  const big = encodeFrame(REQUEST_MARK, 12, "QUERY", { sql: noise });
  assert.ok(big.length > 1, "split into chunks");
  for (const line of big) {
    assert.ok(line.length <= CHUNK_CHARS + 40, "every line stays short");
    assert.match(line, /^@NCQ@ 12 (\+|QUERY [0-9a-f]{8}) [A-Za-z0-9+/=]+\n$/);
  }
  const requests = new FrameDecoder(REQUEST_MARK);
  let result = null;
  for (const line of big) result = requests.feed(line.trimEnd());
  assert.deepEqual(result, { id: 12, kind: "QUERY", payload: { sql: noise } });
});

test("frames are found inside terminal noise and other lines are ignored", () => {
  const decoder = new FrameDecoder(RESPONSE_MARK);
  const [line] = encodeFrame(RESPONSE_MARK, 3, "OK", { ok: true });
  assert.equal(decoder.feed("[host@app]/app$ ls"), null);
  assert.equal(decoder.feed("You have new mail in /var/spool/mail/app"), null);
  // Text a library printed without a line end sits in front of the frame.
  assert.deepEqual(decoder.feed(`[dsci.c],[144],err=[2100]${line.trimEnd()}\u001b[0m`), {
    id: 3,
    kind: "OK",
    payload: { ok: true },
  });
  // The request mark is not a response.
  assert.equal(decoder.feed(encodeFrame(REQUEST_MARK, 3, "PING", {})[0]), null);
});

test("a damaged frame is reported instead of being trusted", () => {
  const decoder = new FrameDecoder(RESPONSE_MARK);
  const [line] = encodeFrame(RESPONSE_MARK, 5, "ROWS", { rows: [["a"]] });
  const broken = line.trimEnd().replace(/.$/, (last) => (last === "A" ? "B" : "A"));
  const result = decoder.feed(broken);
  assert.equal(result.id, 5);
  assert.match(result.error, /checksum/);

  // A lost continuation line changes the checksum too.
  const noise = crypto.randomBytes(3000).toString("hex");
  const lines = encodeFrame(RESPONSE_MARK, 6, "ROWS", { rows: [[noise]] });
  const second = new FrameDecoder(RESPONSE_MARK);
  let outcome = null;
  lines.forEach((part, index) => {
    if (index !== 1) outcome = second.feed(part.trimEnd());
  });
  assert.match(outcome.error, /checksum/);
});

test("LineSplitter handles CRLF, partial lines and the unterminated tail", () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push(Buffer.from("one\r\ntw")), ["one"]);
  assert.equal(splitter.tail, "tw");
  assert.deepEqual(splitter.push("o\nthree\n"), ["two", "three"]);
  assert.deepEqual(splitter.push("Password: "), []);
  assert.equal(splitter.tail, "Password: ");
  // Bytes are kept as they are, so GBK text can be decoded later.
  assert.deepEqual(new LineSplitter().push(Buffer.from([0xd5, 0xc5, 0x0a])), ["ÕÅ"]);
});

test("stripAnsi removes what a terminal would interpret", () => {
  assert.equal(stripAnsi("\u001b[2J\u001b[H\u001b[1;32mok\u001b[0m\u0007"), "ok");
  assert.equal(stripAnsi("\u001b]0;title\u0007prompt$ \u001b[?2004h"), "prompt$ ");
  assert.equal(stripAnsi("a\tb\nc"), "a\tb\nc");
});
