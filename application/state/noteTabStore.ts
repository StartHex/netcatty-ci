import { useSyncExternalStore } from 'react';

import { activeTabStore } from './activeTabStore';
import { STORAGE_KEY_NOTE_TABS } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

/**
 * Notes opened as top tabs. A tab is one note; its top-tab id is the note id
 * behind a prefix, so opening a note that already has a tab goes to that tab.
 * The tab only names the note: title and content are read from the vault.
 */
export const NOTE_TAB_PREFIX = 'note:';

export const toNoteTabId = (noteId: string): string => `${NOTE_TAB_PREFIX}${noteId}`;
export const isNoteTabId = (tabId: string): boolean => tabId.startsWith(NOTE_TAB_PREFIX);
export const fromNoteTabId = (tabId: string): string => tabId.slice(NOTE_TAB_PREFIX.length);

type Listener = () => void;
type TabStorage = {
  read: () => unknown;
  write: (noteIds: readonly string[]) => void;
};

const EMPTY: readonly string[] = Object.freeze([]);

const defaultStorage: TabStorage = {
  read: () => localStorageAdapter.read<unknown>(STORAGE_KEY_NOTE_TABS),
  write: (noteIds) => localStorageAdapter.write(STORAGE_KEY_NOTE_TABS, [...noteIds]),
};

export class NoteTabStore {
  private noteIds: readonly string[] = EMPTY;
  private listeners = new Set<Listener>();
  private loaded = false;

  constructor(
    private readonly activeTabs: Pick<typeof activeTabStore, 'getActiveTabId' | 'setActiveTabId'> = activeTabStore,
    private readonly storage: TabStorage = defaultStorage,
  ) {}

  /** Note ids with an open tab, in the order they were opened. */
  getNoteIds = (): readonly string[] => {
    this.load();
    return this.noteIds;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = this.storage.read();
      if (Array.isArray(stored)) {
        const ids = [...new Set(stored.filter((id): id is string => typeof id === 'string' && id.length > 0))];
        if (ids.length > 0) this.noteIds = ids;
      }
    } catch {
      // A broken stored list only means no tabs are restored.
    }
  }

  private set(next: readonly string[]): void {
    this.noteIds = next.length === 0 ? EMPTY : next;
    try {
      this.storage.write(this.noteIds);
    } catch {
      // Tabs still work for this run without persistence.
    }
    this.listeners.forEach((listener) => listener());
  }

  has(noteId: string): boolean {
    return this.getNoteIds().includes(noteId);
  }

  /** Opens the note in a tab (or goes to the tab it already has). */
  open(noteId: string, options: { activate?: boolean } = {}): void {
    if (!noteId) return;
    if (!this.has(noteId)) this.set([...this.getNoteIds(), noteId]);
    if (options.activate !== false) this.activeTabs.setActiveTabId(toNoteTabId(noteId));
  }

  /** Closes the tab. Focus is the caller's business: it knows the tab order. */
  close(noteId: string): void {
    if (!this.has(noteId)) return;
    this.set(this.getNoteIds().filter((id) => id !== noteId));
  }

  /**
   * Drops tabs whose note no longer exists (deleted here or by a sync).
   * Returns the note ids that were dropped.
   */
  prune(existingNoteIds: ReadonlySet<string>): string[] {
    const current = this.getNoteIds();
    const gone = current.filter((id) => !existingNoteIds.has(id));
    if (gone.length > 0) this.set(current.filter((id) => existingNoteIds.has(id)));
    return gone;
  }
}

export const noteTabStore = new NoteTabStore();

export function useNoteTabIds(): readonly string[] {
  return useSyncExternalStore(noteTabStore.subscribe, noteTabStore.getNoteIds, noteTabStore.getNoteIds);
}
