/**
 * In-editor search highlighting for the rich (MDXEditor / Lexical) note view.
 *
 * Lexical owns its DOM, so highlights are painted with the CSS Custom
 * Highlight API (`::highlight()` + `CSS.highlights`) instead of wrapping text
 * in elements: nothing is inserted into the editable tree, undo history stays
 * clean and the caret is never disturbed. Environments without the API (jsdom
 * in tests, very old engines) simply get no highlight.
 */

import { useEffect, useRef, type RefObject } from "react";

import {
  createNoteSearchPattern,
  noteSearchTermsKey,
  scanNoteSearchMatches,
} from "../../domain/notes/noteSearch";
import type { NoteSearchHighlightRequest } from "./noteEditorTypes";

export const NOTE_SEARCH_HIGHLIGHT_NAME = "netcatty-note-search";
export const NOTE_SEARCH_ACTIVE_HIGHLIGHT_NAME = "netcatty-note-search-active";
/** Enough for any realistic note; keeps a one-letter query from building 50k ranges. */
export const NOTE_SEARCH_MAX_DOM_HIGHLIGHTS = 2000;
const RECOMPUTE_DEBOUNCE_MS = 120;

const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

/** Text inside these never belongs to the note body (toolbars, pickers, KaTeX MathML). */
const SKIP_SELECTOR = [
  "script",
  "style",
  "select",
  "option",
  "button",
  "textarea",
  "input",
  "[aria-hidden='true']",
  "[contenteditable='false'] [role='toolbar']",
  ".katex-mathml",
  "[data-note-search-skip]",
].join(",");

const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
  "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HR", "FIGURE", "DETAILS", "SUMMARY",
]);

type HighlightLike = { priority?: number };
type HighlightConstructor = new (...ranges: Range[]) => HighlightLike;
type HighlightRegistryLike = {
  set: (name: string, highlight: HighlightLike) => unknown;
  delete: (name: string) => unknown;
};

const getHighlightApi = (): { registry: HighlightRegistryLike; Highlight: HighlightConstructor } | null => {
  const scope = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike };
    Highlight?: HighlightConstructor;
  };
  const registry = scope.CSS?.highlights;
  const Highlight = scope.Highlight;
  if (!registry || typeof registry.set !== "function" || typeof Highlight !== "function") return null;
  return { registry, Highlight };
};

export const isNoteSearchHighlightSupported = (): boolean => getHighlightApi() !== null;

/**
 * The registry is document-global while several editors can be mounted at once
 * (vault notes + the terminal side panel), so every editor contributes its own
 * ranges and the registry always holds the union.
 */
const contributions = new Map<symbol, { ranges: Range[]; active: Range | null }>();

const syncHighlightRegistry = (): void => {
  const api = getHighlightApi();
  if (!api) return;
  const all: Range[] = [];
  const active: Range[] = [];
  for (const entry of contributions.values()) {
    for (const range of entry.ranges) all.push(range);
    if (entry.active) active.push(entry.active);
  }
  try {
    if (all.length > 0) api.registry.set(NOTE_SEARCH_HIGHLIGHT_NAME, new api.Highlight(...all));
    else api.registry.delete(NOTE_SEARCH_HIGHLIGHT_NAME);
    if (active.length > 0) {
      const highlight = new api.Highlight(...active);
      highlight.priority = 1;
      api.registry.set(NOTE_SEARCH_ACTIVE_HIGHLIGHT_NAME, highlight);
    } else {
      api.registry.delete(NOTE_SEARCH_ACTIVE_HIGHLIGHT_NAME);
    }
  } catch {
    // A detached range or an engine quirk must never break the editor.
  }
};

export const setNoteSearchHighlightContribution = (
  owner: symbol,
  ranges: Range[],
  active: Range | null,
): void => {
  if (ranges.length === 0 && !active) contributions.delete(owner);
  else contributions.set(owner, { ranges, active });
  syncHighlightRegistry();
};

export const clearNoteSearchHighlightContribution = (owner: symbol): void => {
  if (!contributions.delete(owner)) return;
  syncHighlightRegistry();
};

interface TextSlice {
  node: Text;
  start: number;
  length: number;
}

const nearestBlock = (element: Element | null, root: Element): Element => {
  let current: Element | null = element;
  while (current && current !== root) {
    if (BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return root;
};

/**
 * Concatenates the searchable text under `root`. Text from different blocks
 * is joined with "\n" (outside every slice), so a match can never span two
 * paragraphs or two code lines.
 */
export const collectNoteSearchText = (root: Element): { text: string; slices: TextSlice[] } => {
  const doc = root.ownerDocument;
  const slices: TextSlice[] = [];
  let text = "";
  if (!doc) return { text, slices };
  const walker = doc.createTreeWalker(root, SHOW_TEXT, {
    acceptNode: (node: Node) => {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return FILTER_REJECT;
      if (parent.closest(SKIP_SELECTOR)) return FILTER_REJECT;
      return FILTER_ACCEPT;
    },
  });
  let lastBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    const block = nearestBlock(node.parentElement, root);
    if (lastBlock && block !== lastBlock) text += "\n";
    lastBlock = block;
    slices.push({ node: node as Text, start: text.length, length: value.length });
    text += value;
  }
  return { text, slices };
};

/** Index of the last slice starting at or before `offset` (binary search). */
const sliceIndexAt = (slices: readonly TextSlice[], offset: number, isEnd: boolean): number => {
  let low = 0;
  let high = slices.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = slices[middle].start;
    if (isEnd ? start < offset : start <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

export const createNoteSearchDomRanges = (
  root: Element,
  terms: readonly string[],
  limit = NOTE_SEARCH_MAX_DOM_HIGHLIGHTS,
): Range[] => {
  const pattern = createNoteSearchPattern(terms);
  const doc = root.ownerDocument;
  if (!pattern || !doc) return [];
  const { text, slices } = collectNoteSearchText(root);
  if (!text || slices.length === 0) return [];
  const { ranges } = scanNoteSearchMatches(text, pattern, { maxRanges: limit, maxCount: limit });
  const domRanges: Range[] = [];
  for (const [start, end] of ranges) {
    const startIndex = sliceIndexAt(slices, start, false);
    const endIndex = sliceIndexAt(slices, end, true);
    if (startIndex < 0 || endIndex < 0) continue;
    const startSlice = slices[startIndex];
    const endSlice = slices[endIndex];
    const startOffset = start - startSlice.start;
    const endOffset = end - endSlice.start;
    if (startOffset < 0 || startOffset > startSlice.length) continue;
    if (endOffset < 0 || endOffset > endSlice.length) continue;
    try {
      const range = doc.createRange();
      range.setStart(startSlice.node, startOffset);
      range.setEnd(endSlice.node, endOffset);
      domRanges.push(range);
    } catch {
      // The node changed under us; the next recompute picks it up.
    }
  }
  return domRanges;
};

const prefersReducedMotion = (): boolean => {
  try {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

const canScroll = (overflow: string): boolean => overflow === "auto" || overflow === "scroll" || overflow === "overlay";

/**
 * Scrolls the nearest scroll containers so `range` sits in the upper third of
 * the view. Horizontal scrollers (code blocks) are nudged first, then the
 * first vertical scroller (the editor's ScrollArea viewport) moves smoothly.
 */
export const revealNoteSearchRange = (range: Range): void => {
  const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  const startElement = range.startContainer.nodeType === 1
    ? (range.startContainer as Element)
    : range.startContainer.parentElement;
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    startElement?.scrollIntoView?.({ block: "center", inline: "nearest" });
    return;
  }
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  const doc = range.startContainer.ownerDocument;
  const view = doc?.defaultView;
  for (let element = startElement; element && element !== doc?.body; element = element.parentElement) {
    const style = view?.getComputedStyle(element);
    if (!style) break;
    const box = element.getBoundingClientRect();
    if (canScroll(style.overflowX) && element.scrollWidth > element.clientWidth + 1) {
      if (rect.left < box.left || rect.right > box.right) {
        element.scrollLeft += rect.left - box.left - Math.min(48, box.width / 4);
      }
    }
    if (canScroll(style.overflowY) && element.scrollHeight > element.clientHeight + 1) {
      const margin = Math.min(120, box.height / 3);
      if (rect.top < box.top + 8 || rect.bottom > box.bottom - 8) {
        const top = element.scrollTop + rect.top - box.top - margin;
        if (typeof element.scrollTo === "function") element.scrollTo({ top: Math.max(0, top), behavior });
        else element.scrollTop = Math.max(0, top);
      }
      return;
    }
  }
};

export interface UseNoteSearchHighlightOptions {
  containerRef: RefObject<HTMLElement | null>;
  request: NoteSearchHighlightRequest | undefined;
  /** False while the source editor (or the raw-source fallback) is showing. */
  enabled: boolean;
  /** True while a deferred note switch is still importing the new markdown. */
  isBusy: () => boolean;
  /** Changes whenever the rendered document may have been replaced. */
  contentKey: unknown;
  onMatchCountChange?: (count: number) => void;
}

/**
 * Keeps the rich editor's search highlights in sync with the DOM: recomputes
 * after edits (debounced MutationObserver), honours the active occurrence and
 * reveals it once per `revealToken`.
 */
export function useNoteSearchHighlight({
  containerRef,
  request,
  enabled,
  isBusy,
  contentKey,
  onMatchCountChange,
}: UseNoteSearchHighlightOptions): void {
  const ownerRef = useRef<symbol | null>(null);
  if (ownerRef.current === null) ownerRef.current = Symbol("note-search-highlight");
  const pendingRevealRef = useRef<number | null>(null);
  const lastRevealTokenRef = useRef<number | null>(null);
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  const onMatchCountChangeRef = useRef(onMatchCountChange);
  onMatchCountChangeRef.current = onMatchCountChange;

  const terms = request?.terms ?? [];
  const termsKey = noteSearchTermsKey(terms);
  const termsRef = useRef(terms);
  termsRef.current = terms;
  const activeOccurrence = request?.activeOccurrence ?? null;
  const revealToken = request?.revealToken ?? 0;

  if (lastRevealTokenRef.current !== revealToken) {
    lastRevealTokenRef.current = revealToken;
    if (activeOccurrence !== null) pendingRevealRef.current = revealToken;
  }

  useEffect(() => {
    const owner = ownerRef.current as symbol;
    const container = containerRef.current;
    if (!enabled || !termsKey || !container) {
      clearNoteSearchHighlightContribution(owner);
      return undefined;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const compute = () => {
      timer = null;
      if (disposed) return;
      if (isBusyRef.current()) {
        schedule();
        return;
      }
      const root = container.querySelector(".netcatty-mdx-content");
      if (!root) {
        // The rich editor has not rendered yet; the observer retries once it does.
        clearNoteSearchHighlightContribution(owner);
        return;
      }
      const ranges = createNoteSearchDomRanges(root, termsRef.current);
      const active = activeOccurrence !== null && ranges.length > 0
        ? ranges[((activeOccurrence % ranges.length) + ranges.length) % ranges.length]
        : null;
      setNoteSearchHighlightContribution(owner, ranges, active);
      onMatchCountChangeRef.current?.(ranges.length);
      if (active && pendingRevealRef.current !== null) {
        pendingRevealRef.current = null;
        revealNoteSearchRange(active);
      }
    };

    const schedule = () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(compute, RECOMPUTE_DEBOUNCE_MS);
    };

    compute();
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(() => schedule())
      : null;
    observer?.observe(container, { childList: true, subtree: true, characterData: true });

    return () => {
      disposed = true;
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
      clearNoteSearchHighlightContribution(owner);
    };
  }, [activeOccurrence, containerRef, contentKey, enabled, revealToken, termsKey]);
}
