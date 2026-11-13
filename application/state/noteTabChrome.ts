import { useSyncExternalStore } from 'react';

import { noteTabStore } from './noteTabStore';
import { getNotesSnapshot, subscribeNotes } from './notesStore';

export interface NoteTabChrome {
  /** Note id. */
  id: string;
  title: string;
}

const EMPTY: readonly NoteTabChrome[] = Object.freeze([]);

/**
 * Titles for the open note tabs. The result keeps its identity until a tab is
 * added, removed or retitled, so typing in a note body does not re-render the
 * tab bar.
 */
export function createNoteTabChromeSelector(
  getNoteIds: () => readonly string[],
  getNotes: () => readonly { id: string; title: string }[],
): () => readonly NoteTabChrome[] {
  let lastKey = '';
  let lastValue: readonly NoteTabChrome[] = EMPTY;
  return () => {
    const noteIds = getNoteIds();
    if (noteIds.length === 0) {
      lastKey = '';
      lastValue = EMPTY;
      return EMPTY;
    }
    const wanted = new Set(noteIds);
    const titles = new Map<string, string>();
    for (const note of getNotes()) {
      if (wanted.has(note.id)) titles.set(note.id, note.title);
    }
    const value = noteIds.map((id) => ({ id, title: titles.get(id) ?? '' }));
    const key = value.map((tab) => `${tab.id}\u0000${tab.title}`).join('\u0001');
    if (key === lastKey) return lastValue;
    lastKey = key;
    lastValue = value;
    return value;
  };
}

const selectNoteTabChrome = createNoteTabChromeSelector(
  noteTabStore.getNoteIds,
  () => getNotesSnapshot().notes,
);

const subscribe = (listener: () => void): (() => void) => {
  const offTabs = noteTabStore.subscribe(listener);
  const offNotes = subscribeNotes(listener);
  return () => {
    offTabs();
    offNotes();
  };
};

export function useNoteTabChrome(): readonly NoteTabChrome[] {
  return useSyncExternalStore(subscribe, selectNoteTabChrome, selectNoteTabChrome);
}
