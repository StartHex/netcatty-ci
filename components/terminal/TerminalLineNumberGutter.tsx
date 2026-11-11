import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

import { getTerminalOutputPressure } from "./runtime/terminalOutputPressure";
import {
  TERMINAL_LINE_MARK_COLOR,
  getTerminalLineTools,
  type LineToolsTerminal,
} from "./runtime/terminalLineTools";

export const TERMINAL_LINE_NUMBER_MIN_DIGITS = 4;
export const TERMINAL_LINE_NUMBER_HORIZONTAL_PADDING = 18;
/** Cap gutter paint rate while output is flooding in. */
const FLOOD_MIN_INTERVAL_MS = 100;
const ROW_CLASS =
  "absolute left-0 right-0 pl-2 pr-2 text-right tabular-nums whitespace-nowrap cursor-pointer";

type DisposableLike = { dispose: () => void };

export type TerminalLineNumberGutterRow = { row: number; lineNumber: number; marked: boolean };

/** Width for a gutter that has to fit `lastLineNumber`. */
export const resolveTerminalLineNumberGutterWidth = ({
  lastLineNumber,
  fontSize,
  digitWidth,
}: {
  lastLineNumber: number;
  fontSize: number;
  digitWidth?: number;
}): number => {
  const digits = Math.max(TERMINAL_LINE_NUMBER_MIN_DIGITS, String(Math.max(1, Math.floor(lastLineNumber))).length);
  const perDigit = digitWidth && digitWidth > 0 ? digitWidth : fontSize * 0.62;
  return Math.ceil(digits * perDigit + TERMINAL_LINE_NUMBER_HORIZONTAL_PADDING);
};

/** Rows to paint for what the terminal shows right now. */
export const getVisibleTerminalLineNumberRows = (
  term: LineToolsTerminal,
): TerminalLineNumberGutterRow[] => {
  const tools = getTerminalLineTools(term);
  tools.sync();
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return [];
  const rows: TerminalLineNumberGutterRow[] = [];
  for (let row = 0; row < term.rows; row += 1) {
    const bufferLine = buffer.viewportY + row;
    if (bufferLine >= buffer.length) break;
    rows.push({ row, lineNumber: tools.toLineNumber(bufferLine), marked: tools.hasMarkAt(bufferLine) });
  }
  return rows;
};

type TerminalLineNumberGutterProps = {
  termRef: RefObject<XTerm | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  top: string;
  left?: number;
  bottom?: number;
  sessionId: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  width: number;
  onWidthChange?: (width: number) => void;
  markTitle: string;
};

const getTerminalScreen = (container: HTMLElement): HTMLElement => (
  container.querySelector<HTMLElement>(".xterm-screen") ?? container
);

export function TerminalLineNumberGutter({
  termRef,
  containerRef,
  enabled,
  top,
  left = 0,
  bottom = 0,
  sessionId,
  fontFamily,
  fontSize,
  fontWeight,
  width,
  onWidthChange,
  markTitle,
}: TerminalLineNumberGutterProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;

  useEffect(() => {
    const gutter = gutterRef.current;
    if (!gutter || !enabled) return;

    let disposed = false;
    let rafId: number | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let floodTimer: ReturnType<typeof setTimeout> | null = null;
    let disposables: DisposableLike[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let lastSignature = "";
    let lastRenderAt = 0;
    let digitWidth = 0;
    let reportedWidth = 0;

    const measureDigit = () => {
      const probe = document.createElement("span");
      probe.textContent = "0000000000";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "nowrap";
      probe.style.fontFamily = fontFamily;
      probe.style.fontSize = `${fontSize}px`;
      probe.style.fontWeight = String(fontWeight);
      probe.style.fontVariantNumeric = "tabular-nums";
      gutter.appendChild(probe);
      digitWidth = probe.getBoundingClientRect().width / 10;
      probe.remove();
    };

    const render = () => {
      rafId = null;
      lastRenderAt = performance.now();
      const term = termRef.current;
      const container = containerRef.current;
      if (!term || !container) return;
      const screen = getTerminalScreen(container);
      const cellHeight = screen.clientHeight / Math.max(1, term.rows || 1);
      if (!Number.isFinite(cellHeight) || cellHeight <= 0) return;
      const screenTop = screen.getBoundingClientRect().top - gutter.getBoundingClientRect().top;
      const lineTerm = term as unknown as LineToolsTerminal;
      const rows = getVisibleTerminalLineNumberRows(lineTerm);

      const nextWidth = resolveTerminalLineNumberGutterWidth({
        lastLineNumber: getTerminalLineTools(lineTerm).getRange().last,
        fontSize,
        digitWidth,
      });
      if (nextWidth !== reportedWidth) {
        reportedWidth = nextWidth;
        onWidthChangeRef.current?.(nextWidth);
      }

      let signature = `${screenTop}|${cellHeight}`;
      for (const row of rows) signature += `|${row.row}:${row.lineNumber}${row.marked ? "*" : ""}`;
      if (signature === lastSignature) return;
      lastSignature = signature;

      const existing = gutter.children;
      let index = 0;
      for (; index < rows.length; index += 1) {
        const { row, lineNumber, marked } = rows[index];
        let item = existing[index] as HTMLElement | undefined;
        if (!item) {
          item = document.createElement("div");
          item.className = ROW_CLASS;
          gutter.appendChild(item);
        }
        const label = String(lineNumber);
        if (item.textContent !== label) item.textContent = label;
        item.dataset.row = String(row);
        item.dataset.marked = marked ? "true" : "false";
        item.style.top = `${screenTop + row * cellHeight}px`;
        item.style.height = `${cellHeight}px`;
        item.style.lineHeight = `${cellHeight}px`;
        item.style.color = marked ? TERMINAL_LINE_MARK_COLOR : "";
        item.style.fontWeight = marked ? "700" : "";
        item.style.boxShadow = marked ? `inset 2px 0 0 ${TERMINAL_LINE_MARK_COLOR}` : "";
        item.style.background = marked ? "color-mix(in srgb, #f59e0b 14%, transparent)" : "";
        item.style.display = "";
      }
      for (; index < existing.length; index += 1) {
        (existing[index] as HTMLElement).style.display = "none";
      }
    };

    const queue = () => {
      if (disposed || rafId !== null) return;
      rafId = requestAnimationFrame(render);
    };

    const schedule = (priority: "immediate" | "normal") => {
      if (disposed) return;
      const term = termRef.current;
      if (priority === "normal" && term) {
        const pressure = getTerminalOutputPressure(term);
        if (pressure.largeOutput || pressure.longLine) {
          const elapsed = performance.now() - lastRenderAt;
          if (elapsed < FLOOD_MIN_INTERVAL_MS) {
            if (floodTimer === null) {
              floodTimer = setTimeout(() => {
                floodTimer = null;
                queue();
              }, FLOOD_MIN_INTERVAL_MS - elapsed);
            }
            return;
          }
        }
      }
      queue();
    };

    const onClick = (event: MouseEvent) => {
      const term = termRef.current;
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-row]");
      if (!term || !target) return;
      const row = Number(target.dataset.row);
      if (!Number.isInteger(row)) return;
      const lineTerm = term as unknown as LineToolsTerminal;
      getTerminalLineTools(lineTerm).toggleMark(lineTerm.buffer.active.viewportY + row);
      term.focus();
    };
    // Keep the click from starting a text selection or stealing focus first.
    const onMouseDown = (event: MouseEvent) => event.preventDefault();

    const attach = () => {
      if (disposed) return;
      const term = termRef.current;
      const container = containerRef.current;
      if (!term || !container) {
        retryTimer = setTimeout(attach, 50);
        return;
      }
      measureDigit();
      const tools = getTerminalLineTools(term as unknown as LineToolsTerminal);
      disposables = [
        term.onScroll?.(() => schedule(getTerminalOutputPressure(term).largeOutput ? "normal" : "immediate")),
        term.onRender?.(() => schedule("normal")),
        term.onResize?.(() => schedule("immediate")),
      ].filter(Boolean) as DisposableLike[];
      disposables.push({ dispose: tools.onChange(() => schedule("immediate")) });
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => schedule("immediate"));
        resizeObserver.observe(container);
        resizeObserver.observe(getTerminalScreen(container));
      }
      const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
      void fonts?.ready?.then(() => {
        if (disposed) return;
        measureDigit();
        lastSignature = "";
        schedule("immediate");
      });
      schedule("immediate");
    };

    gutter.addEventListener("click", onClick);
    gutter.addEventListener("mousedown", onMouseDown);
    attach();

    return () => {
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (retryTimer) clearTimeout(retryTimer);
      if (floodTimer !== null) clearTimeout(floodTimer);
      for (const disposable of disposables) disposable.dispose();
      resizeObserver?.disconnect();
      gutter.removeEventListener("click", onClick);
      gutter.removeEventListener("mousedown", onMouseDown);
      while (gutter.firstChild) gutter.removeChild(gutter.firstChild);
    };
  }, [bottom, containerRef, enabled, fontFamily, fontSize, fontWeight, left, sessionId, termRef, top]);

  if (!enabled) return null;

  return (
    <div
      ref={gutterRef}
      title={markTitle}
      className="absolute z-[1] overflow-hidden select-none text-[color:var(--terminal-ui-fg)]"
      style={{
        top,
        bottom,
        left,
        width,
        fontFamily,
        fontSize,
        fontWeight,
        backgroundColor: "var(--terminal-ui-bg)",
        color: "color-mix(in srgb, var(--terminal-ui-fg) 45%, transparent)",
        boxShadow: "inset -0.5px 0 0 color-mix(in srgb, var(--terminal-ui-fg) 8%, transparent)",
      }}
      data-section="terminal-line-number-gutter"
    />
  );
}
