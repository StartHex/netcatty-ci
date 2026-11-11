import test from "node:test";
import assert from "node:assert/strict";

import {
  TerminalLineTools,
  joinBufferRows,
  parseLineRangeInput,
  pickCyclicMarkIndex,
  type LineToolsMarker,
  type LineToolsTerminal,
} from "./terminalLineTools";

type FakeMarker = LineToolsMarker & { line: number; isDisposed: boolean; listeners: Array<() => void> };

/** A scrollback buffer that drops rows from the top like xterm does. */
function createFakeTerminal(options: { rows?: number; scrollback?: number } = {}) {
  const rows = options.rows ?? 5;
  const maxLength = rows + (options.scrollback ?? 20);
  const lines: { text: string; wrapped: boolean }[] = [{ text: "", wrapped: false }];
  const markers: FakeMarker[] = [];
  const scrolledTo: number[] = [];
  let viewportY = 0;
  let type = "normal";

  const baseY = () => Math.max(0, lines.length - rows);
  const cursorY = () => lines.length - 1 - baseY();

  const term: LineToolsTerminal = {
    rows,
    cols: 80,
    buffer: {
      active: {
        get type() { return type; },
        get length() { return lines.length; },
        get baseY() { return baseY(); },
        get cursorY() { return cursorY(); },
        get viewportY() { return viewportY; },
        getLine: (index: number) => {
          const line = lines[index];
          return line ? { isWrapped: line.wrapped, translateToString: () => line.text } : undefined;
        },
      },
    },
    registerMarker: (offset = 0) => {
      if (type !== "normal") return undefined;
      const marker: FakeMarker = {
        line: baseY() + cursorY() + offset,
        isDisposed: false,
        listeners: [],
        dispose() {
          if (marker.isDisposed) return;
          marker.isDisposed = true;
          marker.line = -1;
          for (const listener of marker.listeners) listener();
        },
        onDispose(listener) {
          marker.listeners.push(listener);
          return { dispose: () => undefined };
        },
      };
      markers.push(marker);
      return marker;
    },
    scrollToLine: (line: number) => {
      scrolledTo.push(line);
      viewportY = Math.min(line, baseY());
    },
  };

  const trim = (count: number) => {
    lines.splice(0, count);
    for (const marker of markers) {
      if (marker.isDisposed) continue;
      if (marker.line < count) marker.dispose();
      else marker.line -= count;
    }
  };

  return {
    term,
    scrolledTo,
    /** Prints one row after the current one; `wrapped` continues the row above. */
    print(text: string, wrapped = false) {
      const atBottom = viewportY >= baseY();
      if (lines.length === 1 && lines[0].text === "") lines[0] = { text, wrapped };
      else lines.push({ text, wrapped });
      if (lines.length > maxLength) trim(lines.length - maxLength);
      if (atBottom) viewportY = baseY();
    },
    printMany(count: number, prefix = "row") {
      for (let index = 0; index < count; index += 1) this.print(`${prefix} ${index + 1}`);
    },
    clear() {
      for (const marker of markers) marker.dispose();
      lines.splice(0, lines.length, { text: "", wrapped: false });
      viewportY = 0;
    },
    scrollTo(line: number) { viewportY = Math.min(line, baseY()); },
    setType(next: string) { type = next; },
    get length() { return lines.length; },
  };
}

test("line box input accepts a number or a range in several spellings", () => {
  assert.deepEqual(parseLineRangeInput("120"), { from: 120, to: null });
  assert.deepEqual(parseLineRangeInput(" 120 - 340 "), { from: 120, to: 340 });
  assert.deepEqual(parseLineRangeInput("120:340"), { from: 120, to: 340 });
  assert.deepEqual(parseLineRangeInput("120,340"), { from: 120, to: 340 });
  assert.deepEqual(parseLineRangeInput("120 340"), { from: 120, to: 340 });
  assert.deepEqual(parseLineRangeInput("120..340"), { from: 120, to: 340 });
  assert.deepEqual(parseLineRangeInput("120到340"), { from: 120, to: 340 });
  assert.deepEqual(parseLineRangeInput("１２０－３４０"), { from: 120, to: 340 });
  assert.deepEqual(parseLineRangeInput("340-120"), { from: 120, to: 340 });
  assert.equal(parseLineRangeInput(""), null);
  assert.equal(parseLineRangeInput("0"), null);
  assert.equal(parseLineRangeInput("12a"), null);
  assert.equal(parseLineRangeInput("1-2-3"), null);
  assert.equal(parseLineRangeInput("-5"), null);
});

test("stepping through marks wraps around at both ends", () => {
  const lines = [10, 40, 90];
  assert.equal(pickCyclicMarkIndex(lines, 10, 1), 1);
  assert.equal(pickCyclicMarkIndex(lines, 40, 1), 2);
  assert.equal(pickCyclicMarkIndex(lines, 90, 1), 0);
  assert.equal(pickCyclicMarkIndex(lines, 90, -1), 1);
  assert.equal(pickCyclicMarkIndex(lines, 10, -1), 2);
  assert.equal(pickCyclicMarkIndex(lines, 50, 1), 2);
  assert.equal(pickCyclicMarkIndex(lines, 50, -1), 1);
  assert.equal(pickCyclicMarkIndex([], 5, 1), -1);
});

test("wrapped rows continue the row above when joined", () => {
  assert.equal(
    joinBufferRows([
      { text: "abc", wrapped: false },
      { text: "def", wrapped: true },
      { text: "ghi", wrapped: false },
    ]),
    "abcdef\nghi",
  );
});

test("line numbers keep naming the same row after scrollback drops old rows", () => {
  const fake = createFakeTerminal({ rows: 5, scrollback: 20 });
  const tools = new TerminalLineTools(fake.term);
  fake.printMany(20);
  tools.sync();
  assert.deepEqual(tools.getRange(), { first: 1, last: 20 });
  assert.equal(tools.readRange(7, 7)?.text, "row 7");

  // 40 rows in a 25-row buffer: the first 15 are gone.
  for (let index = 20; index < 40; index += 1) {
    fake.print(`row ${index + 1}`);
    tools.sync();
  }
  assert.deepEqual(tools.getRange(), { first: 16, last: 40 });
  assert.equal(tools.readRange(30, 30)?.text, "row 30");
  assert.equal(tools.toBufferLine(15), null);
  assert.equal(tools.toBufferLine(41), null);
  assert.equal(tools.toLineNumber(0), 16);
});

test("reading a range clamps to what is left and reports it", () => {
  const fake = createFakeTerminal({ rows: 5, scrollback: 5 });
  const tools = new TerminalLineTools(fake.term);
  for (let index = 0; index < 30; index += 1) {
    fake.print(`row ${index + 1}`);
    tools.sync();
  }
  assert.deepEqual(tools.getRange(), { first: 21, last: 30 });
  const read = tools.readRange(18, 23);
  assert.deepEqual(read && { from: read.from, to: read.to, rows: read.rows, clamped: read.clamped }, {
    from: 21, to: 23, rows: 3, clamped: true,
  });
  assert.equal(read?.text, "row 21\nrow 22\nrow 23");
  assert.equal(tools.readRange(1, 5), null);
  assert.equal(tools.readRange(25, 24)?.text, "row 24\nrow 25");
});

test("a wrapped line inside a range is copied as one line", () => {
  const fake = createFakeTerminal();
  const tools = new TerminalLineTools(fake.term);
  fake.print("head");
  fake.print("long part one ");
  fake.print("part two", true);
  fake.print("tail");
  assert.equal(tools.readRange(1, 4)?.text, "head\nlong part one part two\ntail");
  // Starting on the continuation row still copies that row.
  assert.equal(tools.readRange(3, 4)?.text, "part two\ntail");
});

test("marks toggle, list top to bottom with line numbers, and follow dropped rows", () => {
  const fake = createFakeTerminal({ rows: 5, scrollback: 20 });
  const tools = new TerminalLineTools(fake.term);
  fake.printMany(20);
  let changes = 0;
  tools.onChange(() => { changes += 1; });

  assert.equal(tools.toggleMark(14), true);
  assert.equal(tools.toggleMark(4), true);
  assert.equal(tools.toggleMark(9), true);
  assert.deepEqual(tools.listMarks().map((mark) => [mark.lineNumber, mark.preview]), [
    [5, "row 5"], [10, "row 10"], [15, "row 15"],
  ]);
  assert.equal(tools.hasMarkAt(9), true);
  assert.equal(tools.toggleMark(9), false);
  assert.deepEqual(tools.listMarks().map((mark) => mark.lineNumber), [5, 15]);
  assert.ok(changes >= 4);

  // Ten more rows drop rows 1-5: the mark on line 5 goes with its row,
  // the one on line 15 keeps its number at a new buffer index.
  for (let index = 20; index < 30; index += 1) {
    fake.print(`row ${index + 1}`);
    tools.sync();
  }
  assert.deepEqual(tools.listMarks().map((mark) => [mark.lineNumber, mark.bufferLine, mark.preview]), [
    [15, 9, "row 15"],
  ]);
  tools.clearMarks();
  assert.equal(tools.getMarkCount(), 0);
});

test("next and previous mark cycle and scroll the mark into view", () => {
  const fake = createFakeTerminal({ rows: 6, scrollback: 100 });
  const tools = new TerminalLineTools(fake.term);
  fake.printMany(60);
  tools.toggleMark(9);
  tools.toggleMark(29);
  tools.toggleMark(49);

  // At the bottom (rows 55-60 visible) the next mark wraps to the first.
  assert.deepEqual(tools.stepMark(1), { index: 0, total: 3, lineNumber: 10 });
  assert.equal(fake.scrolledTo.at(-1), 7);
  assert.deepEqual(tools.stepMark(1), { index: 1, total: 3, lineNumber: 30 });
  assert.deepEqual(tools.stepMark(1), { index: 2, total: 3, lineNumber: 50 });
  assert.deepEqual(tools.stepMark(1), { index: 0, total: 3, lineNumber: 10 });
  assert.deepEqual(tools.stepMark(-1), { index: 2, total: 3, lineNumber: 50 });
  assert.deepEqual(tools.stepMark(-1), { index: 1, total: 3, lineNumber: 30 });

  // After scrolling away by hand, stepping goes by what is on screen.
  fake.scrollTo(40);
  assert.deepEqual(tools.stepMark(-1), { index: 1, total: 3, lineNumber: 30 });
  fake.scrollTo(0);
  assert.deepEqual(tools.stepMark(1), { index: 0, total: 3, lineNumber: 10 });
});

test("go to line clamps to the buffer and clearing restarts the count", () => {
  const fake = createFakeTerminal({ rows: 5, scrollback: 5 });
  const tools = new TerminalLineTools(fake.term);
  for (let index = 0; index < 30; index += 1) {
    fake.print(`row ${index + 1}`);
    tools.sync();
  }
  assert.equal(tools.goToLine(3), 21);
  assert.equal(tools.goToLine(999), 30);
  assert.equal(tools.goToLine(25), 25);
  assert.equal(fake.scrolledTo.at(-1), 3);

  fake.clear();
  tools.sync();
  fake.print("fresh");
  assert.deepEqual(tools.getRange(), { first: 1, last: 1 });
  assert.equal(tools.readRange(1, 1)?.text, "fresh");
});

test("nothing is marked or read while a full-screen program owns the screen", () => {
  const fake = createFakeTerminal();
  const tools = new TerminalLineTools(fake.term);
  fake.printMany(8);
  fake.setType("alternate");
  assert.equal(tools.isAlternateScreen(), true);
  assert.equal(tools.toggleMark(2), false);
  assert.equal(tools.readRange(1, 3), null);
});
