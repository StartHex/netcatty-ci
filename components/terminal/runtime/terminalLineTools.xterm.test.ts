import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/xterm";

import { TerminalLineTools, type LineToolsTerminal } from "./terminalLineTools";

const { Terminal } = xterm;

const write = (term: InstanceType<typeof Terminal>, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const rowsText = (from: number, to: number) => {
  let text = "";
  for (let index = from; index <= to; index += 1) text += `row ${index}\r\n`;
  return text;
};

const createTools = (options: { rows?: number; cols?: number; scrollback?: number } = {}) => {
  const term = new Terminal({
    cols: options.cols ?? 40,
    rows: options.rows ?? 5,
    scrollback: options.scrollback ?? 50,
    allowProposedApi: true,
  });
  const tools = new TerminalLineTools(term as unknown as LineToolsTerminal);
  return { term, tools };
};

test("real xterm: numbers survive scrollback trimming across many writes", async () => {
  const { term, tools } = createTools({ rows: 5, scrollback: 50 });
  await write(term, rowsText(1, 30));
  // 30 rows plus the empty row the cursor sits on.
  assert.deepEqual(tools.getRange(), { first: 1, last: 31 });
  assert.equal(tools.readRange(12, 14)?.text, "row 12\nrow 13\nrow 14");

  for (let start = 31; start <= 400; start += 37) {
    await write(term, rowsText(start, Math.min(400, start + 36)));
  }
  const range = tools.getRange();
  assert.equal(range.last, 401);
  assert.equal(range.first, 401 - term.buffer.active.length + 1);
  assert.equal(term.buffer.active.length, 55);
  assert.equal(tools.readRange(380, 382)?.text, "row 380\nrow 381\nrow 382");
  assert.equal(tools.readRange(range.first, range.first)?.text, `row ${range.first}`);
  assert.equal(tools.toBufferLine(range.first - 1), null);
  term.dispose();
});

test("real xterm: a burst larger than the whole buffer still lands on the right numbers", async () => {
  const { term, tools } = createTools({ rows: 5, scrollback: 50 });
  await write(term, rowsText(1, 20));
  assert.equal(tools.getRange().last, 21);
  // One write of 500 rows: every row the tools knew about is gone at once.
  await write(term, rowsText(21, 520));
  const range = tools.getRange();
  const text = tools.readRange(range.last - 1, range.last - 1)?.text ?? "";
  assert.match(text, /^row \d+$/);
  // The count cannot be exact after such a burst, but it never goes backwards
  // and every later row keeps a stable number from here on.
  assert.ok(range.first > 1);
  const before = tools.readRange(range.last - 3, range.last - 3)?.text;
  await write(term, rowsText(521, 530));
  assert.equal(tools.readRange(range.last - 3, range.last - 3)?.text, before);
  term.dispose();
});

test("real xterm: marks keep their line number and go when their row is dropped", async () => {
  const { term, tools } = createTools({ rows: 5, scrollback: 50 });
  await write(term, rowsText(1, 40));
  assert.equal(tools.toggleMark(9), true);
  assert.equal(tools.toggleMark(29), true);
  assert.deepEqual(tools.listMarks().map((mark) => [mark.lineNumber, mark.preview]), [
    [10, "row 10"], [30, "row 30"],
  ]);

  await write(term, rowsText(41, 70));
  // 71 rows in a 55-row buffer: rows 1-16 are gone, so is the mark on row 10.
  assert.deepEqual(tools.listMarks().map((mark) => [mark.lineNumber, mark.preview]), [[30, "row 30"]]);
  assert.equal(tools.listMarks()[0].bufferLine, 30 - 1 - 16);

  const step = tools.stepMark(1);
  assert.deepEqual(step, { index: 0, total: 1, lineNumber: 30 });
  assert.ok(term.buffer.active.viewportY <= 13 && term.buffer.active.viewportY + term.rows > 13);
  term.dispose();
});

test("real xterm: a wrapped line reads back as one line and clear restarts the count", async () => {
  const { term, tools } = createTools({ rows: 5, cols: 10, scrollback: 50 });
  await write(term, "short\r\nabcdefghijklmnopqrstuvwx\r\ntail\r\n");
  // The 24-character line takes three rows of ten columns.
  assert.equal(tools.readRange(1, 5)?.text, "short\nabcdefghijklmnopqrstuvwx\ntail");
  assert.equal(tools.readRange(3, 3)?.text, "klmnopqrst");

  await write(term, rowsText(1, 80));
  assert.ok(tools.getRange().first > 1);
  term.clear();
  tools.sync();
  await write(term, "after clear\r\n");
  const range = tools.getRange();
  assert.equal(range.first, 1);
  assert.match(tools.readRange(1, range.last)?.text ?? "", /after clear/);
  term.dispose();
});
