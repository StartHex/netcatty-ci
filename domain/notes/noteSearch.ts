/**
 * Full-text search for the Notes manager.
 *
 * Pure helpers only: query parsing (whitespace separated terms plus
 * "quoted phrases"), AND matching across title / body / folder / tags / linked
 * hosts, and highlight ranges + per-line snippets so the tree can show *where*
 * a note matched. Matching is case-insensitive. Every range is reported in the
 * original text's UTF-16 offsets, so callers can slice and highlight without
 * searching again.
 */

import type { Host, VaultNote } from "../models";

/** Half-open `[start, end)` offsets into the searched text. */
export type NoteSearchRange = readonly [start: number, end: number];

export interface NoteSearchSegment {
  text: string;
  highlighted: boolean;
}

export interface NoteSearchSnippet {
  /** Body occurrence index (0-based, document order) of the first match on this line. */
  occurrence: number;
  /** Number of body matches that start on this line. */
  matchCount: number;
  /** 1-based source line. */
  line: number;
  text: string;
  /** Highlight ranges relative to `text`. */
  highlights: NoteSearchRange[];
  leadingEllipsis: boolean;
  trailingEllipsis: boolean;
}

export interface NoteSearchHit {
  noteId: string;
  titleRanges: NoteSearchRange[];
  /** Body matches, capped at `maxBodyMatches`. */
  bodyMatchCount: number;
  bodyMatchCountCapped: boolean;
  snippets: NoteSearchSnippet[];
  /** First body occurrence that no snippet shows (equals the count when all are shown). */
  nextOccurrence: number;
  /** Folder / tag / linked-host text that matched when neither title nor body did. */
  meta?: { text: string; highlights: NoteSearchRange[] };
}

export interface NoteSearchResult {
  terms: string[];
  hits: Map<string, NoteSearchHit>;
  /** Title + body matches across every hit (body counts are capped per note). */
  totalMatches: number;
}

export interface NoteSearchOptions {
  /** Snippet lines kept per note (default 3). */
  maxSnippets?: number;
  /** Body matches counted per note before the count is reported as capped. */
  maxBodyMatches?: number;
}

const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 200;
const SNIPPET_LEAD_CHARS = 24;
const SNIPPET_MAX_CHARS = 160;
const SNIPPET_RANGE_LIMIT = 400;
const DEFAULT_MAX_SNIPPETS = 3;
const DEFAULT_MAX_BODY_MATCHES = 999;
/** Markdown block prefixes skipped at the start of a snippet line. */
const BLOCK_MARKER_PATTERN = /^(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/;

/**
 * Splits a raw query into search terms. Bare words are separated by
 * whitespace; `"double quoted"` text stays one phrase (an unterminated quote
 * runs to the end, which is what you get while still typing it). Duplicates
 * are dropped case-insensitively.
 */
export const parseNoteSearchTerms = (query: string): string[] => {
  const terms: string[] = [];
  if (typeof query !== "string" || !query.trim()) return terms;
  const seen = new Set<string>();
  const tokenPattern = /"([^"]*)"?|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(query)) !== null) {
    const raw = match[1] !== undefined ? match[1] : match[2] ?? "";
    const term = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TERM_LENGTH);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
};

export const escapeNoteSearchRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One case-insensitive alternation for every term, longest first, so a longer
 * term wins over a shorter one that starts at the same offset.
 */
export const createNoteSearchPattern = (terms: readonly string[]): RegExp | null => {
  const usable = terms.filter((term) => typeof term === "string" && term.length > 0);
  if (usable.length === 0) return null;
  const ordered = [...usable].sort((left, right) => right.length - left.length);
  return new RegExp(ordered.map(escapeNoteSearchRegExp).join("|"), "gi");
};

/** True when every term occurs in `text` (case-insensitive). */
export const noteSearchTextMatchesAll = (text: string, terms: readonly string[]): boolean => {
  if (terms.length === 0) return true;
  const haystack = (text ?? "").toLowerCase();
  return terms.every((term) => haystack.includes(term.toLowerCase()));
};

export interface NoteSearchScan {
  ranges: NoteSearchRange[];
  count: number;
  capped: boolean;
}

/** Counts matches (up to `maxCount`) and keeps the first `maxRanges` ranges. */
export const scanNoteSearchMatches = (
  text: string,
  pattern: RegExp | null,
  options: { maxRanges?: number; maxCount?: number } = {},
): NoteSearchScan => {
  const maxRanges = options.maxRanges ?? Number.POSITIVE_INFINITY;
  const maxCount = Math.max(1, options.maxCount ?? DEFAULT_MAX_BODY_MATCHES);
  const ranges: NoteSearchRange[] = [];
  if (!pattern || !text) return { ranges, count: 0, capped: false };
  pattern.lastIndex = 0;
  let count = 0;
  let capped = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const length = match[0].length;
    if (length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    if (ranges.length < maxRanges) ranges.push([match.index, match.index + length]);
    count += 1;
    if (count >= maxCount) {
      capped = pattern.exec(text) !== null;
      break;
    }
  }
  pattern.lastIndex = 0;
  return { ranges, count, capped };
};

export const findNoteSearchRanges = (
  text: string,
  pattern: RegExp | null,
  limit = 200,
): NoteSearchRange[] => scanNoteSearchMatches(text, pattern, { maxRanges: limit, maxCount: limit }).ranges;

/**
 * Splits `text` into plain / highlighted segments. Ranges are sorted, clamped
 * to the text and merged, so callers may pass them in any shape.
 */
export const splitTextByNoteSearchRanges = (
  text: string,
  ranges: readonly NoteSearchRange[],
): NoteSearchSegment[] => {
  if (!text) return [];
  const normalized = ranges
    .map(([start, end]) => [Math.max(0, Math.min(start, text.length)), Math.max(0, Math.min(end, text.length))] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of normalized) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  const segments: NoteSearchSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), highlighted: false });
    segments.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments;
};

/**
 * Builds one snippet per matching line (first `maxSnippets` lines). Each
 * snippet starts a little before the first match on its line so the hit is
 * visible even in a narrow tree; leading indentation and Markdown block
 * markers are skipped when the match comes after them.
 */
export const buildNoteSearchSnippets = (
  text: string,
  ranges: readonly NoteSearchRange[],
  maxSnippets = DEFAULT_MAX_SNIPPETS,
): NoteSearchSnippet[] => {
  const snippets: NoteSearchSnippet[] = [];
  if (!text || ranges.length === 0 || maxSnippets <= 0) return snippets;

  let lineNumber = 1;
  let lineStart = 0;
  let index = 0;
  while (index < ranges.length && snippets.length < maxSnippets) {
    const matchStart = ranges[index][0];
    let newline = text.indexOf("\n", lineStart);
    while (newline !== -1 && newline < matchStart) {
      lineNumber += 1;
      lineStart = newline + 1;
      newline = text.indexOf("\n", lineStart);
    }
    const lineBreak = newline === -1 ? text.length : newline;
    let lineEnd = lineBreak;
    if (lineEnd > lineStart && text[lineEnd - 1] === "\r") lineEnd -= 1;

    const firstOccurrence = index;
    const lineRanges: NoteSearchRange[] = [];
    while (index < ranges.length && ranges[index][0] < lineBreak) {
      lineRanges.push(ranges[index]);
      index += 1;
    }
    const firstMatch = lineRanges[0][0];

    let contentStart = lineStart;
    while (contentStart < lineEnd && (text[contentStart] === " " || text[contentStart] === "\t")) {
      contentStart += 1;
    }
    const marker = BLOCK_MARKER_PATTERN.exec(text.slice(contentStart, Math.min(lineEnd, contentStart + 16)));
    if (marker) contentStart += marker[0].length;
    contentStart = Math.min(contentStart, firstMatch);

    let windowStart = Math.max(contentStart, firstMatch - SNIPPET_LEAD_CHARS);
    if (windowStart > contentStart) {
      const space = text.indexOf(" ", windowStart);
      if (space !== -1 && space < firstMatch - 4) windowStart = space + 1;
    }
    const windowEnd = Math.min(lineEnd, windowStart + SNIPPET_MAX_CHARS);
    const highlights = lineRanges
      .map(([start, end]) => [
        Math.max(start, windowStart) - windowStart,
        Math.min(end, windowEnd) - windowStart,
      ] as const)
      .filter(([start, end]) => end > start);

    snippets.push({
      occurrence: firstOccurrence,
      matchCount: lineRanges.length,
      line: lineNumber,
      text: text.slice(windowStart, windowEnd).replace(/\t/g, " "),
      highlights,
      leadingEllipsis: windowStart > contentStart,
      trailingEllipsis: windowEnd < lineEnd,
    });
    lineStart = lineBreak + 1;
    if (lineBreak < text.length) lineNumber += 1;
  }
  return snippets;
};

interface NoteSearchEntry {
  note: VaultNote;
  group: string;
  tags: string[];
  linkedHosts: string[];
  lowerFields: string[];
}

const buildEntry = (note: VaultNote, hostLabels: ReadonlyMap<string, string>): NoteSearchEntry => {
  const group = note.group ?? "";
  const tags = note.tags ?? [];
  const linkedHosts = (note.linkedHostIds ?? [])
    .map((id) => hostLabels.get(id))
    .filter((label): label is string => Boolean(label));
  return {
    note,
    group,
    tags,
    linkedHosts,
    lowerFields: [note.title ?? "", note.content ?? "", group, ...tags, ...linkedHosts].map((value) =>
      value.toLowerCase(),
    ),
  };
};

const buildMeta = (
  entry: NoteSearchEntry,
  lowerTerms: readonly string[],
  pattern: RegExp,
): NoteSearchHit["meta"] => {
  const matchesAny = (value: string) => {
    const lower = value.toLowerCase();
    return lowerTerms.some((term) => lower.includes(term));
  };
  const parts: string[] = [];
  if (entry.group && matchesAny(entry.group)) parts.push(entry.group);
  const tags = entry.tags.filter(matchesAny).map((tag) => `#${tag}`);
  if (tags.length > 0) parts.push(tags.join(" "));
  const hosts = entry.linkedHosts.filter(matchesAny);
  if (hosts.length > 0) parts.push(hosts.join(", "));
  if (parts.length === 0) return undefined;
  const text = parts.join(" · ");
  return { text, highlights: findNoteSearchRanges(text, pattern, 50) };
};

/**
 * Indexes a note snapshot once (lower-cased fields are reused for every
 * keystroke) and returns a search function. A note matches when every term
 * occurs in at least one of its fields: title, body, folder, a tag, or a
 * linked host's label/hostname.
 */
export const createNoteSearchIndex = (
  notes: readonly VaultNote[],
  hosts: readonly Host[] = [],
) => {
  const hostLabels = new Map<string, string>();
  for (const host of hosts) hostLabels.set(host.id, `${host.label ?? ""} ${host.hostname ?? ""}`.trim());
  const entries = notes.map((note) => buildEntry(note, hostLabels));

  return (query: string, options: NoteSearchOptions = {}): NoteSearchResult => {
    const terms = parseNoteSearchTerms(query);
    const hits = new Map<string, NoteSearchHit>();
    const pattern = createNoteSearchPattern(terms);
    if (!pattern) return { terms, hits, totalMatches: 0 };

    const maxSnippets = options.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
    const maxBodyMatches = options.maxBodyMatches ?? DEFAULT_MAX_BODY_MATCHES;
    const lowerTerms = terms.map((term) => term.toLowerCase());
    let totalMatches = 0;

    for (const entry of entries) {
      const matched = lowerTerms.every((term) => entry.lowerFields.some((field) => field.includes(term)));
      if (!matched) continue;
      const titleRanges = findNoteSearchRanges(entry.note.title ?? "", pattern, 50);
      const body = scanNoteSearchMatches(entry.note.content ?? "", pattern, {
        maxRanges: SNIPPET_RANGE_LIMIT,
        maxCount: maxBodyMatches,
      });
      const snippets = buildNoteSearchSnippets(entry.note.content ?? "", body.ranges, maxSnippets);
      const lastSnippet = snippets[snippets.length - 1];
      const nextOccurrence = lastSnippet
        ? Math.min(body.count, lastSnippet.occurrence + lastSnippet.matchCount)
        : 0;
      const hit: NoteSearchHit = {
        noteId: entry.note.id,
        titleRanges,
        bodyMatchCount: body.count,
        bodyMatchCountCapped: body.capped,
        snippets,
        nextOccurrence,
      };
      if (titleRanges.length === 0 && body.count === 0) {
        const meta = buildMeta(entry, lowerTerms, pattern);
        if (meta) hit.meta = meta;
      }
      hits.set(entry.note.id, hit);
      totalMatches += titleRanges.length + body.count;
    }
    return { terms, hits, totalMatches };
  };
};

/** Stable identity for a term list (used as a memo / effect key). */
export const noteSearchTermsKey = (terms: readonly string[]): string => terms.join("\u0000");
