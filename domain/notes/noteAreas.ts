/**
 * Note areas: everyday notes ("daily") and cleaned-up notes ("organized").
 *
 * The area is a field on the note, not a folder: both areas share the folder
 * tree and a note keeps its folder when it moves. A daily note that has been
 * folded into an organized note stays where it is, marked as organized and
 * hidden by default, so the original wording is never lost.
 *
 * Pure functions only; callers persist the returned list.
 */
import type { VaultNote } from "../models";

export type NoteArea = "daily" | "organized";

export const NOTE_AREAS: readonly NoteArea[] = ["daily", "organized"];

export const getNoteArea = (note: Pick<VaultNote, "area">): NoteArea =>
  note.area === "organized" ? "organized" : "daily";

export const parseNoteArea = (value: unknown): NoteArea | null =>
  value === "daily" || value === "organized" ? value : null;

/** A daily note whose content has already been written up in the organized area. */
export const isNoteOrganizedAway = (note: Pick<VaultNote, "area" | "organizedAt">): boolean =>
  getNoteArea(note) === "daily" && typeof note.organizedAt === "number";

export interface NoteAreaCounts {
  daily: number;
  /** Daily notes still waiting to be organized. */
  dailyPending: number;
  organized: number;
}

export const countNotesByArea = (notes: readonly VaultNote[]): NoteAreaCounts => {
  const counts: NoteAreaCounts = { daily: 0, dailyPending: 0, organized: 0 };
  for (const note of notes) {
    if (getNoteArea(note) === "organized") {
      counts.organized += 1;
    } else {
      counts.daily += 1;
      if (!isNoteOrganizedAway(note)) counts.dailyPending += 1;
    }
  }
  return counts;
};

/** Notes shown when browsing one area. */
export const filterNotesForArea = <T extends VaultNote>(
  notes: readonly T[],
  area: NoteArea,
  options: { hideOrganizedAway?: boolean } = {},
): T[] =>
  notes.filter((note) => {
    if (getNoteArea(note) !== area) return false;
    if (area === "daily" && options.hideOrganizedAway && isNoteOrganizedAway(note)) return false;
    return true;
  });

const withArea = (note: VaultNote, area: NoteArea): VaultNote => {
  const { area: _previous, ...rest } = note;
  return area === "organized" ? { ...rest, area: "organized" } : rest;
};

/**
 * Move notes to an area. The folder is kept unless `group` is given (empty
 * string clears it). A note moved by hand is a note in its own right again,
 * so its "organized away" mark is dropped. Returns the same array when
 * nothing changes.
 */
export const moveNotesToArea = (
  notes: readonly VaultNote[],
  noteIds: readonly string[],
  area: NoteArea,
  options: { group?: string; now?: number } = {},
): { notes: VaultNote[]; movedIds: string[] } => {
  const ids = new Set(noteIds);
  const now = options.now ?? Date.now();
  const movedIds: string[] = [];
  const next = notes.map((note) => {
    if (!ids.has(note.id)) return note;
    const nextGroup = options.group === undefined ? note.group : options.group.trim() || undefined;
    if (getNoteArea(note) === area && nextGroup === note.group) return note;
    movedIds.push(note.id);
    const { organizedAt: _at, organizedInto: _into, ...rest } = withArea(note, area);
    return { ...rest, group: nextGroup, updatedAt: now };
  });
  return movedIds.length === 0 ? { notes: notes as VaultNote[], movedIds } : { notes: next, movedIds };
};

/**
 * Record that daily notes were written up as `organizedNoteId`: the sources
 * get the organized mark (and stay in the daily area), the organized note
 * lists them in `organizedFrom`. Organized-area notes and the target itself
 * are never marked.
 */
export const markNotesOrganized = (
  notes: readonly VaultNote[],
  sourceIds: readonly string[],
  organizedNoteId: string | undefined,
  now: number = Date.now(),
): { notes: VaultNote[]; markedIds: string[] } => {
  const ids = new Set(sourceIds);
  const markedIds: string[] = [];
  let next = notes.map((note) => {
    if (!ids.has(note.id) || note.id === organizedNoteId || getNoteArea(note) !== "daily") return note;
    markedIds.push(note.id);
    return {
      ...note,
      organizedAt: now,
      ...(organizedNoteId ? { organizedInto: organizedNoteId } : {}),
    };
  });
  if (markedIds.length === 0) return { notes: notes as VaultNote[], markedIds };
  if (organizedNoteId) {
    next = next.map((note) => {
      if (note.id !== organizedNoteId) return note;
      const merged = Array.from(new Set([...(note.organizedFrom ?? []), ...markedIds]));
      return { ...note, organizedFrom: merged };
    });
  }
  return { notes: next, markedIds };
};

/** Undo {@link markNotesOrganized} for the given daily notes. */
export const unmarkNotesOrganized = (
  notes: readonly VaultNote[],
  sourceIds: readonly string[],
): { notes: VaultNote[]; unmarkedIds: string[] } => {
  const ids = new Set(sourceIds);
  const unmarkedIds: string[] = [];
  let next = notes.map((note) => {
    if (!ids.has(note.id) || typeof note.organizedAt !== "number") return note;
    unmarkedIds.push(note.id);
    const { organizedAt: _at, organizedInto: _into, ...rest } = note;
    return rest;
  });
  if (unmarkedIds.length === 0) return { notes: notes as VaultNote[], unmarkedIds };
  const removed = new Set(unmarkedIds);
  next = next.map((note) => {
    if (!note.organizedFrom?.some((id) => removed.has(id))) return note;
    const remaining = note.organizedFrom.filter((id) => !removed.has(id));
    const { organizedFrom: _from, ...rest } = note;
    return remaining.length > 0 ? { ...rest, organizedFrom: remaining } : rest;
  });
  return { notes: next, unmarkedIds };
};

export interface NoteListFilter {
  area?: NoteArea;
  /** Folder path; matches the folder itself and its subfolders. */
  group?: string;
  /** true: only daily notes already organized; false: only notes not organized yet. */
  organized?: boolean;
  updatedAfter?: number;
  updatedBefore?: number;
  createdAfter?: number;
  createdBefore?: number;
  limit?: number;
}

export const MAX_NOTE_LIST_LIMIT = 500;

/** Filter notes for tools; newest first, so "today's notes" come back first. */
export const filterNotesForList = <T extends VaultNote>(
  notes: readonly T[],
  filter: NoteListFilter = {},
): { notes: T[]; total: number; truncated: boolean } => {
  const group = filter.group?.trim().replace(/^\/+|\/+$/g, "");
  const matched = notes.filter((note) => {
    if (filter.area && getNoteArea(note) !== filter.area) return false;
    if (group !== undefined && group !== "") {
      const own = note.group ?? "";
      if (own !== group && !own.startsWith(`${group}/`)) return false;
    }
    if (filter.organized === true && !isNoteOrganizedAway(note)) return false;
    if (filter.organized === false && (isNoteOrganizedAway(note) || getNoteArea(note) === "organized")) return false;
    if (filter.updatedAfter !== undefined && note.updatedAt < filter.updatedAfter) return false;
    if (filter.updatedBefore !== undefined && note.updatedAt >= filter.updatedBefore) return false;
    if (filter.createdAfter !== undefined && note.createdAt < filter.createdAfter) return false;
    if (filter.createdBefore !== undefined && note.createdAt >= filter.createdBefore) return false;
    return true;
  });
  matched.sort((left, right) => right.updatedAt - left.updatedAt);
  const limit = Math.max(1, Math.min(MAX_NOTE_LIST_LIMIT, Math.floor(filter.limit ?? MAX_NOTE_LIST_LIMIT)));
  return { notes: matched.slice(0, limit), total: matched.length, truncated: matched.length > limit };
};

/**
 * Parse a tool-supplied instant: epoch milliseconds, or an ISO date / date-time
 * (`2026-11-11` is local midnight, like a person means it). null when invalid.
 */
export const parseNoteTimeBound = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const time = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
    return Number.isNaN(time) ? null : time;
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
};
