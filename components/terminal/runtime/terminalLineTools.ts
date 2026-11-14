/**
 * Line numbers, line marks and line-range reads for a terminal.
 *
 * A line number here is the 1-based position of a buffer row counted from the
 * first row the session ever printed, not from the top of what is still in
 * scrollback. xterm drops the oldest rows once scrollback is full and shifts
 * every remaining index down; the tools follow that with an anchor marker, so
 * "line 48213" keeps naming the same row for as long as the row exists.
 *
 * Rows are buffer rows: a long output line that wraps takes several numbers.
 */

export type LineToolsDisposable = { dispose: () => void };

export type LineToolsMarker = LineToolsDisposable & {
  readonly line: number;
  readonly isDisposed: boolean;
  onDispose?: (listener: () => void) => LineToolsDisposable;
};

type LineToolsBufferLine = {
  isWrapped: boolean;
  translateToString: (trimRight?: boolean) => string;
};

type LineToolsBuffer = {
  type: string;
  length: number;
  baseY: number;
  cursorY: number;
  viewportY: number;
  getLine: (index: number) => LineToolsBufferLine | undefined;
};

type LineToolsDecoration = LineToolsDisposable & {
  onRender?: (listener: (element: HTMLElement) => void) => LineToolsDisposable;
};

/** The part of xterm's Terminal the line tools use. */
export type LineToolsTerminal = {
  rows: number;
  cols: number;
  buffer: { active: LineToolsBuffer };
  registerMarker: (cursorYOffset?: number) => LineToolsMarker | undefined;
  registerDecoration?: (options: {
    marker: LineToolsMarker;
    x?: number;
    width?: number;
    layer?: "bottom" | "top";
  }) => LineToolsDecoration | undefined;
  scrollToLine: (line: number) => void;
  getSelectionPosition?: () => { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  hasSelection?: () => boolean;
  onScroll?: (listener: () => void) => LineToolsDisposable;
  onWriteParsed?: (listener: () => void) => LineToolsDisposable;
};

export type TerminalLineMark = {
  id: number;
  /** Row index in the buffer right now. */
  bufferLine: number;
  lineNumber: number;
  preview: string;
};

export type TerminalLineRange = { from: number; to: number | null };

export type TerminalLineRangeText = {
  text: string;
  /** Line numbers actually read, after clamping to what is still in the buffer. */
  from: number;
  to: number;
  rows: number;
  clamped: boolean;
};

export type TerminalMarkStep = { index: number; total: number; lineNumber: number };

/**
 * How far above the cursor the anchor may fall before a fresh one is placed.
 * In a short buffer the limit is half the buffer, so the anchor is never the
 * next row to be dropped.
 */
const ANCHOR_REFRESH_DISTANCE = 1000;
const MARK_PREVIEW_MAX = 80;
export const TERMINAL_LINE_MARK_COLOR = "#f59e0b";
export const TERMINAL_LINE_FLASH_MS = 1400;

const FULL_WIDTH_ZERO = 0xff10;

/**
 * Parses what the user types into the line box: `120` or a range such as
 * `120-340`, `120:340`, `120,340`, `120 340`, `120~340`, `120到340`. Full-width
 * digits and dashes from a Chinese input method are accepted. A reversed
 * range is put in order. Returns null for anything else.
 */
export function parseLineRangeInput(input: string): TerminalLineRange | null {
  const normalized = input
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - FULL_WIDTH_ZERO))
    .replace(/[－–—−～]/g, "-")
    .replace(/[：，、]/g, ",")
    .trim();
  const match = /^(\d{1,12})(?:\s*(?:-|:|,|~|\.\.|到|至|\s)\s*(\d{1,12}))?$/.exec(normalized);
  if (!match) return null;
  const first = Number(match[1]);
  if (!Number.isSafeInteger(first) || first < 1) return null;
  if (match[2] === undefined) return { from: first, to: null };
  const second = Number(match[2]);
  if (!Number.isSafeInteger(second) || second < 1) return null;
  return first <= second ? { from: first, to: second } : { from: second, to: first };
}

/**
 * Index of the mark to visit next. `lines` is ascending. Going forward picks
 * the first mark after `reference` and wraps to the first one; going back
 * picks the last mark before it and wraps to the last one. -1 when empty.
 */
export function pickCyclicMarkIndex(
  lines: readonly number[],
  reference: number,
  direction: 1 | -1,
): number {
  if (lines.length === 0) return -1;
  if (direction === 1) {
    const next = lines.findIndex((line) => line > reference);
    return next === -1 ? 0 : next;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] < reference) return index;
  }
  return lines.length - 1;
}

/** Joins buffer rows into text: a wrapped row continues the row above it. */
export function joinBufferRows(rows: readonly { text: string; wrapped: boolean }[]): string {
  let text = "";
  rows.forEach((row, index) => {
    if (index > 0 && !row.wrapped) text += "\n";
    text += row.text;
  });
  return text;
}

type MarkEntry = {
  id: number;
  marker: LineToolsMarker;
  disposables: LineToolsDisposable[];
};

export class TerminalLineTools {
  private readonly term: LineToolsTerminal;
  private readonly listeners = new Set<() => void>();
  private readonly marks = new Map<number, MarkEntry>();
  private readonly subscriptions: LineToolsDisposable[] = [];
  private anchor: LineToolsMarker | null = null;
  /** Rows dropped from the top of scrollback when the anchor was placed, plus its row. */
  private anchorAbsolute = 0;
  private trimmed = 0;
  private lastLength = 0;
  /** Row of the anchor at the previous sync. */
  private anchorLastLine = 0;
  private nextMarkId = 1;
  private lastVisitedMarkId: number | null = null;
  private flash: LineToolsDisposable[] = [];
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(term: LineToolsTerminal) {
    this.term = term;
    const track = () => this.sync();
    const onWrite = term.onWriteParsed?.(track);
    if (onWrite) this.subscriptions.push(onWrite);
    const onScroll = term.onScroll?.(track);
    if (onScroll) this.subscriptions.push(onScroll);
    this.sync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.clearFlash();
    for (const entry of [...this.marks.values()]) this.dropMark(entry, false);
    this.anchor?.dispose();
    this.anchor = null;
    this.listeners.clear();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private get buffer(): LineToolsBuffer {
    return this.term.buffer.active;
  }

  /** True while a full-screen program (vim, less, htop) owns the screen. */
  isAlternateScreen(): boolean {
    return this.buffer.type !== "normal";
  }

  /**
   * Brings the count of dropped rows up to date. Cheap; called on every write
   * and scroll and before every read.
   */
  sync(): void {
    if (this.disposed) return;
    const buffer = this.buffer;
    if (buffer.type !== "normal") return;
    const anchor = this.anchor;
    let changed = false;
    if (anchor && !anchor.isDisposed && anchor.line >= 0) {
      const trimmed = this.anchorAbsolute - anchor.line;
      if (trimmed !== this.trimmed && trimmed >= 0) {
        this.trimmed = trimmed;
        changed = true;
      }
    } else if (anchor) {
      // The anchor row is gone. A buffer that shrank was cleared, so counting
      // starts over. Otherwise more rows were dropped in one burst than could
      // be followed: at least everything down to the anchor went, which is
      // the closest count available.
      if (buffer.length < this.lastLength) {
        if (this.trimmed !== 0) changed = true;
        this.trimmed = 0;
      } else {
        this.trimmed = this.anchorAbsolute + 1;
        changed = true;
      }
      this.anchor = null;
    }
    const cursorLine = buffer.baseY + buffer.cursorY;
    const current = this.anchor;
    const limit = Math.min(ANCHOR_REFRESH_DISTANCE, Math.max(1, Math.floor(buffer.length / 2)));
    if (!current || cursorLine - current.line > limit) {
      const fresh = this.term.registerMarker(0);
      if (fresh) {
        current?.dispose();
        this.anchor = fresh;
        this.anchorAbsolute = this.trimmed + fresh.line;
      }
    }
    this.anchorLastLine = this.anchor ? this.anchor.line : 0;
    this.lastLength = buffer.length;
    if (changed) this.emit();
  }

  /** Line number of a buffer row. */
  toLineNumber(bufferLine: number): number {
    return this.trimmed + bufferLine + 1;
  }

  /** Buffer row of a line number, or null when the row is no longer (or not yet) there. */
  toBufferLine(lineNumber: number): number | null {
    this.sync();
    const bufferLine = lineNumber - 1 - this.trimmed;
    return bufferLine >= 0 && bufferLine < this.buffer.length ? bufferLine : null;
  }

  /** First and last line number still in the buffer. */
  getRange(): { first: number; last: number } {
    this.sync();
    return { first: this.trimmed + 1, last: this.trimmed + Math.max(1, this.buffer.length) };
  }

  // ---- marks ---------------------------------------------------------------

  private findMarkAt(bufferLine: number): MarkEntry | null {
    for (const entry of this.marks.values()) {
      if (entry.marker.line === bufferLine) return entry;
    }
    return null;
  }

  hasMarkAt(bufferLine: number): boolean {
    return this.findMarkAt(bufferLine) !== null;
  }

  private dropMark(entry: MarkEntry, notify: boolean): void {
    if (!this.marks.delete(entry.id)) return;
    if (this.lastVisitedMarkId === entry.id) this.lastVisitedMarkId = null;
    for (const disposable of entry.disposables) disposable.dispose();
    if (!entry.marker.isDisposed) entry.marker.dispose();
    if (notify) this.emit();
  }

  private registerMarkerAt(bufferLine: number): LineToolsMarker | null {
    const buffer = this.buffer;
    if (buffer.type !== "normal") return null;
    if (bufferLine < 0 || bufferLine >= buffer.length) return null;
    return this.term.registerMarker(bufferLine - (buffer.baseY + buffer.cursorY)) ?? null;
  }

  private decorate(marker: LineToolsMarker, kind: "mark" | "flash"): LineToolsDisposable | null {
    const decoration = this.term.registerDecoration?.({ marker, x: 0, width: 1, layer: "bottom" });
    if (!decoration) return null;
    decoration.onRender?.((element) => {
      // xterm sizes the element to one cell; stretch it over the row.
      element.style.left = "0";
      element.style.width = "100%";
      element.style.pointerEvents = "none";
      element.style.boxSizing = "border-box";
      element.style.borderLeft = `2px solid ${TERMINAL_LINE_MARK_COLOR}`;
      element.style.background = kind === "mark"
        ? "color-mix(in srgb, #f59e0b 13%, transparent)"
        : "color-mix(in srgb, #f59e0b 30%, transparent)";
      element.dataset.terminalLineDecoration = kind;
    });
    return decoration;
  }

  /** Adds a mark on the row, or removes the one already there. Returns true when a mark was added. */
  toggleMark(bufferLine: number): boolean {
    this.sync();
    const existing = this.findMarkAt(bufferLine);
    if (existing) {
      this.dropMark(existing, true);
      return false;
    }
    const marker = this.registerMarkerAt(bufferLine);
    if (!marker) return false;
    const entry: MarkEntry = { id: this.nextMarkId, marker, disposables: [] };
    this.nextMarkId += 1;
    const decoration = this.decorate(marker, "mark");
    if (decoration) entry.disposables.push(decoration);
    // The row scrolled out of scrollback (or the buffer was cleared).
    const onDispose = marker.onDispose?.(() => this.dropMark(entry, true));
    if (onDispose) entry.disposables.push(onDispose);
    this.marks.set(entry.id, entry);
    this.emit();
    return true;
  }

  removeMark(id: number): void {
    const entry = this.marks.get(id);
    if (entry) this.dropMark(entry, true);
  }

  clearMarks(): void {
    if (this.marks.size === 0) return;
    for (const entry of [...this.marks.values()]) this.dropMark(entry, false);
    this.emit();
  }

  getMarkCount(): number {
    return this.marks.size;
  }

  /** Marks from top to bottom. */
  listMarks(): TerminalLineMark[] {
    this.sync();
    const buffer = this.buffer;
    const marks: TerminalLineMark[] = [];
    for (const entry of this.marks.values()) {
      const bufferLine = entry.marker.line;
      if (entry.marker.isDisposed || bufferLine < 0) continue;
      const text = buffer.type === "normal"
        ? buffer.getLine(bufferLine)?.translateToString(true) ?? ""
        : "";
      const trimmedText = text.trim();
      marks.push({
        id: entry.id,
        bufferLine,
        lineNumber: this.toLineNumber(bufferLine),
        preview: trimmedText.length > MARK_PREVIEW_MAX ? `${trimmedText.slice(0, MARK_PREVIEW_MAX)}…` : trimmedText,
      });
    }
    return marks.sort((a, b) => a.bufferLine - b.bufferLine);
  }

  /**
   * The row a keyboard "toggle mark" acts on: the first selected row, else the
   * top visible row when scrolled back, else the cursor row.
   */
  getDefaultMarkLine(): number {
    const buffer = this.buffer;
    if (this.term.hasSelection?.()) {
      const selection = this.term.getSelectionPosition?.();
      if (selection && selection.start.y >= 0 && selection.start.y < buffer.length) return selection.start.y;
    }
    if (buffer.viewportY < buffer.baseY) return buffer.viewportY;
    return buffer.baseY + buffer.cursorY;
  }

  /**
   * Scrolls to the next or previous mark, wrapping around at either end.
   * Stepping continues from the mark visited last while it is still on
   * screen, otherwise from what is on screen now.
   */
  stepMark(direction: 1 | -1): TerminalMarkStep | null {
    const marks = this.listMarks();
    if (marks.length === 0) return null;
    const buffer = this.buffer;
    const top = buffer.viewportY;
    const bottom = top + this.term.rows - 1;
    const visited = this.lastVisitedMarkId === null
      ? undefined
      : marks.find((mark) => mark.id === this.lastVisitedMarkId);
    const reference = visited && visited.bufferLine >= top && visited.bufferLine <= bottom
      ? visited.bufferLine
      : (direction === 1 ? top - 0.5 : bottom + 0.5);
    const index = pickCyclicMarkIndex(marks.map((mark) => mark.bufferLine), reference, direction);
    const target = marks[index];
    this.lastVisitedMarkId = target.id;
    this.reveal(target.bufferLine);
    return { index, total: marks.length, lineNumber: target.lineNumber };
  }

  visitMark(id: number): TerminalMarkStep | null {
    const marks = this.listMarks();
    const index = marks.findIndex((mark) => mark.id === id);
    if (index === -1) return null;
    this.lastVisitedMarkId = id;
    this.reveal(marks[index].bufferLine);
    return { index, total: marks.length, lineNumber: marks[index].lineNumber };
  }

  // ---- navigation ----------------------------------------------------------

  private clearFlash(): void {
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = null;
    for (const disposable of this.flash) disposable.dispose();
    this.flash = [];
  }

  /** Scrolls so the row sits a third of the way down the screen and flashes it. */
  reveal(bufferLine: number): void {
    const buffer = this.buffer;
    if (buffer.type !== "normal") return;
    const line = Math.max(0, Math.min(buffer.length - 1, bufferLine));
    this.term.scrollToLine(Math.max(0, line - Math.floor(this.term.rows / 3)));
    this.clearFlash();
    const marker = this.registerMarkerAt(line);
    if (!marker) return;
    const decoration = this.decorate(marker, "flash");
    this.flash = decoration ? [decoration, marker] : [marker];
    this.flashTimer = setTimeout(() => this.clearFlash(), TERMINAL_LINE_FLASH_MS);
  }

  /** Jumps to a line number. Returns the number shown, clamped to what the buffer still holds. */
  goToLine(lineNumber: number): number {
    const { first, last } = this.getRange();
    const clamped = Math.max(first, Math.min(last, lineNumber));
    const bufferLine = this.toBufferLine(clamped);
    if (bufferLine !== null) this.reveal(bufferLine);
    return clamped;
  }

  // ---- reading -------------------------------------------------------------

  /** Text of lines `from`..`to` inclusive. Null when none of them is in the buffer any more. */
  readRange(from: number, to: number): TerminalLineRangeText | null {
    const { first, last } = this.getRange();
    const buffer = this.buffer;
    if (buffer.type !== "normal") return null;
    const low = Math.max(first, Math.min(from, to));
    const high = Math.min(last, Math.max(from, to));
    if (low > high) return null;
    const start = low - 1 - this.trimmed;
    const end = high - 1 - this.trimmed;
    const rows: { text: string; wrapped: boolean }[] = [];
    for (let index = start; index <= end; index += 1) {
      const line = buffer.getLine(index);
      // The first row is copied from its start even when it continues a
      // wrapped line: the user asked for these rows, not the logical line.
      rows.push({
        text: line?.translateToString(true) ?? "",
        wrapped: index > start && line?.isWrapped === true,
      });
    }
    return {
      text: joinBufferRows(rows),
      from: low,
      to: high,
      rows: rows.length,
      clamped: low !== Math.min(from, to) || high !== Math.max(from, to),
    };
  }
}

const registry = new WeakMap<object, TerminalLineTools>();

/** The line tools of a terminal, created on first use and kept for its lifetime. */
export function getTerminalLineTools(term: LineToolsTerminal): TerminalLineTools {
  let tools = registry.get(term);
  if (!tools) {
    tools = new TerminalLineTools(term);
    registry.set(term, tools);
  }
  return tools;
}

export const TERMINAL_LINE_ACTION_EVENT = "netcatty:terminal-line-action";

export type TerminalLineAction =
  | "toggleTerminalLineNumbers"
  | "goToTerminalLine"
  | "toggleTerminalLineMark"
  | "nextTerminalLineMark"
  | "prevTerminalLineMark";

export const TERMINAL_LINE_ACTIONS: readonly TerminalLineAction[] = [
  "toggleTerminalLineNumbers",
  "goToTerminalLine",
  "toggleTerminalLineMark",
  "nextTerminalLineMark",
  "prevTerminalLineMark",
];

export const isTerminalLineAction = (action: string): action is TerminalLineAction =>
  (TERMINAL_LINE_ACTIONS as readonly string[]).includes(action);
