import { useSyncExternalStore } from 'react';

import { activeTabStore } from './activeTabStore';
import { STORAGE_KEY_DATABASE_TABS } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export const DATABASE_TAB_PREFIX = 'database:';

export const toDatabaseTabId = (tabId: string): string => `${DATABASE_TAB_PREFIX}${tabId}`;
export const isDatabaseTabId = (tabId: string): boolean => tabId.startsWith(DATABASE_TAB_PREFIX);
export const fromDatabaseTabId = (tabId: string): string => tabId.slice(DATABASE_TAB_PREFIX.length);

export type DatabaseWorkbenchTabStatus = 'idle' | 'connecting' | 'ready' | 'error';

/**
 * Lightweight summary of a database workbench tab. The workbench hook owns the
 * live tab objects (results, editor state); this store mirrors what the tab bar,
 * the close path and persistence need without importing the workbench itself.
 */
export interface DatabaseTabSummary {
  id: string;
  connectionId: string;
  title: string;
  kind: string;
  status: DatabaseWorkbenchTabStatus;
  transactionOpen?: boolean;
}

export interface PersistedDatabaseTab {
  id: string;
  connectionId: string;
  title: string;
  sql: string;
  /** Local .sql file the draft was opened from / saved to. */
  filePath?: string;
}

export interface PersistedDatabaseTabsState {
  tabs: PersistedDatabaseTab[];
  activeTabId?: string;
}

export type DatabaseTabRequest =
  | { type: 'open'; connectionId: string; forceNew?: boolean; nonce: number }
  | { type: 'close'; tabId: string; nonce: number }
  | { type: 'duplicate'; tabId: string; nonce: number }
  | null;

type Listener = () => void;

const EMPTY_TABS: readonly DatabaseTabSummary[] = Object.freeze([]);

class DatabaseTabStore {
  private tabs: readonly DatabaseTabSummary[] = EMPTY_TABS;
  private activeTabId: string | null = null;
  private request: DatabaseTabRequest = null;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private hydratedSql = new Map<string, string>();

  getTabs = (): readonly DatabaseTabSummary[] => this.tabs;
  getTab = (id: string): DatabaseTabSummary | undefined => this.tabs.find((tab) => tab.id === id);
  getActiveTabId = (): string | null => this.activeTabId;
  getRequest = (): DatabaseTabRequest => this.request;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify = () => {
    this.listeners.forEach((listener) => listener());
  };

  sync = (
    tabs: readonly DatabaseTabSummary[],
    activeTabId: string | null,
    options?: { persist?: boolean },
  ): void => {
    const sameTabs =
      tabs.length === this.tabs.length &&
      tabs.every((tab, index) => {
        const current = this.tabs[index];
        return (
          current.id === tab.id &&
          current.title === tab.title &&
          current.status === tab.status &&
          current.connectionId === tab.connectionId &&
          current.transactionOpen === tab.transactionOpen
        );
      });
    const sameActive = activeTabId === this.activeTabId;
    this.tabs = tabs.length === 0 ? EMPTY_TABS : tabs;
    this.activeTabId = activeTabId;
    if (options?.persist !== false) this.scheduleSave();
    if (!sameTabs || !sameActive) this.notify();
  };

  /** Persist only the SQL drafts and identity — results and secrets are runtime data. */
  saveDrafts = (drafts: readonly PersistedDatabaseTab[], activeTabId: string | null): void => {
    const state: PersistedDatabaseTabsState = {
      tabs: [...drafts],
      ...(activeTabId ? { activeTabId } : {}),
    };
    localStorageAdapter.write(STORAGE_KEY_DATABASE_TABS, state);
  };

  loadDraft = (tabId: string): string | undefined => this.hydratedSql.get(tabId);

  loadPersisted = (): PersistedDatabaseTabsState | null => {
    const state = localStorageAdapter.read<PersistedDatabaseTabsState>(STORAGE_KEY_DATABASE_TABS);
    if (!state || !Array.isArray(state.tabs)) return null;
    const tabs = state.tabs.filter(
      (tab) =>
        tab &&
        typeof tab.id === 'string' &&
        typeof tab.connectionId === 'string' &&
        typeof tab.title === 'string',
    );
    this.hydratedSql = new Map(tabs.map((tab) => [tab.id, typeof tab.sql === 'string' ? tab.sql : '']));
    return { tabs, ...(state.activeTabId ? { activeTabId: state.activeTabId } : {}) };
  };

  requestOpen = (connectionId: string, options?: { forceNew?: boolean }): void => {
    this.request = {
      type: 'open',
      connectionId,
      ...(options?.forceNew ? { forceNew: true } : {}),
      nonce: Date.now() + Math.random(),
    };
    this.notify();
  };

  markActive = (tabId: string): void => {
    if (this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.notify();
  };

  requestClose = (tabId: string): void => {
    this.request = { type: 'close', tabId, nonce: Date.now() + Math.random() };
    this.notify();
  };

  /** Open a second tab on the same connection carrying the same SQL draft. */
  requestDuplicate = (tabId: string): void => {
    this.request = { type: 'duplicate', tabId, nonce: Date.now() + Math.random() };
    this.notify();
  };

  clearRequest = (nonce: number): void => {
    if (this.request?.nonce !== nonce) return;
    this.request = null;
  };

  activate = (tabId: string): void => {
    activeTabStore.setActiveTabId(toDatabaseTabId(tabId));
  };

  private scheduleSave = (): void => {
    // Saving is driven by the workbench hook (it owns the SQL text); the store
    // only coalesces UI-driven runs so the tab bar does not spam localStorage.
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
    }, 0);
  };
}

export const databaseTabStore = new DatabaseTabStore();

export function useDatabaseTabs(): readonly DatabaseTabSummary[] {
  return useSyncExternalStore(databaseTabStore.subscribe, databaseTabStore.getTabs, databaseTabStore.getTabs);
}

export function useDatabaseTabRequest(): DatabaseTabRequest {
  return useSyncExternalStore(
    databaseTabStore.subscribe,
    databaseTabStore.getRequest,
    databaseTabStore.getRequest,
  );
}

export function useIsDatabaseActive(): boolean {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    () => isDatabaseTabId(activeTabStore.getActiveTabId()),
    () => false,
  );
}
