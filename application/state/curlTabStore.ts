import { useSyncExternalStore } from 'react';

import { activeTabStore } from './activeTabStore';
import { STORAGE_KEY_HTTP_TABS } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export const CURL_TAB_PREFIX = 'curl:';

export const toCurlTabId = (tabId: string): string => `${CURL_TAB_PREFIX}${tabId}`;
export const isCurlTabId = (tabId: string): boolean => tabId.startsWith(CURL_TAB_PREFIX);
export const fromCurlTabId = (tabId: string): string => tabId.slice(CURL_TAB_PREFIX.length);

export type CurlTabStatus = 'idle' | 'sending' | 'done' | 'error';

/**
 * Lightweight summary of a Curl tab. The client hook owns the live request and
 * response objects; this store only mirrors what the tab bar, the close path and
 * persistence need, so the tab bar never imports the client hook.
 */
export interface CurlTabSummary {
  id: string;
  requestId?: string;
  title: string;
  method: string;
  status: CurlTabStatus;
  dirty?: boolean;
}

export interface PersistedCurlTab {
  id: string;
  requestId?: string;
  title: string;
}

export interface PersistedCurlTabsState {
  tabs: PersistedCurlTab[];
  activeTabId?: string;
}

export type CurlTabRequest =
  | { type: 'open'; requestId?: string; nonce: number }
  | { type: 'close'; tabId: string; nonce: number }
  | { type: 'duplicate'; tabId: string; nonce: number }
  | null;

type PendingCurlTabRequest = Exclude<CurlTabRequest, null>;
/** `Omit` applied to each variant of the union on its own. */
type WithoutNonce<Request> = Request extends unknown ? Omit<Request, 'nonce'> : never;

type Listener = () => void;

const EMPTY_TABS: readonly CurlTabSummary[] = Object.freeze([]);
const NO_REQUESTS: readonly PendingCurlTabRequest[] = Object.freeze([]);

class CurlTabStore {
  private tabs: readonly CurlTabSummary[] = EMPTY_TABS;
  private activeTabId: string | null = null;
  /**
   * Requests wait in line: "close all" raises one close per tab in the same
   * tick, and a single slot would keep only the last of them.
   */
  private requests: readonly PendingCurlTabRequest[] = NO_REQUESTS;
  private nextNonce = 1;
  private listeners = new Set<Listener>();

  getTabs = (): readonly CurlTabSummary[] => this.tabs;
  getTab = (id: string): CurlTabSummary | undefined => this.tabs.find((tab) => tab.id === id);
  getActiveTabId = (): string | null => this.activeTabId;
  /** The oldest request nobody has taken yet. */
  getRequest = (): CurlTabRequest => this.requests[0] ?? null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify = () => {
    this.listeners.forEach((listener) => listener());
  };

  sync = (tabs: readonly CurlTabSummary[], activeTabId: string | null): void => {
    const sameTabs =
      tabs.length === this.tabs.length &&
      tabs.every((tab, index) => {
        const current = this.tabs[index];
        return (
          current.id === tab.id &&
          current.title === tab.title &&
          current.method === tab.method &&
          current.status === tab.status &&
          current.requestId === tab.requestId &&
          current.dirty === tab.dirty
        );
      });
    const sameActive = activeTabId === this.activeTabId;
    this.tabs = tabs.length === 0 ? EMPTY_TABS : tabs;
    this.activeTabId = activeTabId;
    if (!sameTabs || !sameActive) this.notify();
  };

  /** Persist tab identity only — bodies and credentials stay in the vault. */
  saveDrafts = (tabs: readonly CurlTabSummary[], activeTabId: string | null): void => {
    const state: PersistedCurlTabsState = {
      tabs: tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        ...(tab.requestId ? { requestId: tab.requestId } : {}),
      })),
      ...(activeTabId ? { activeTabId } : {}),
    };
    localStorageAdapter.write(STORAGE_KEY_HTTP_TABS, state);
  };

  loadPersisted = (): PersistedCurlTabsState | null => {
    const state = localStorageAdapter.read<PersistedCurlTabsState>(STORAGE_KEY_HTTP_TABS);
    if (!state || !Array.isArray(state.tabs)) return null;
    const tabs = state.tabs.filter(
      (tab) => tab && typeof tab.id === 'string' && typeof tab.title === 'string',
    );
    return { tabs, ...(state.activeTabId ? { activeTabId: state.activeTabId } : {}) };
  };

  private enqueue = (request: WithoutNonce<PendingCurlTabRequest>): void => {
    this.requests = [...this.requests, { ...request, nonce: this.nextNonce++ } as PendingCurlTabRequest];
    this.notify();
  };

  requestOpen = (requestId?: string): void => {
    this.enqueue({
      type: 'open',
      ...(requestId ? { requestId } : {}),
    });
  };

  markActive = (tabId: string): void => {
    if (this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.notify();
  };

  requestClose = (tabId: string): void => {
    this.enqueue({ type: 'close', tabId });
  };

  /** Open an unsaved copy of the tab's current draft in a new tab. */
  requestDuplicate = (tabId: string): void => {
    this.enqueue({ type: 'duplicate', tabId });
  };

  /**
   * Claims a request for handling. Returns false when it is no longer waiting,
   * so a handler that runs twice for the same request acts on it once. Taking
   * one brings the next in line to the front.
   */
  takeRequest = (nonce: number): boolean => {
    const remaining = this.requests.filter((request) => request.nonce !== nonce);
    if (remaining.length === this.requests.length) return false;
    this.requests = remaining.length === 0 ? NO_REQUESTS : remaining;
    if (remaining.length > 0) this.notify();
    return true;
  };

  clearRequest = (nonce: number): void => {
    this.takeRequest(nonce);
  };

  activate = (tabId: string): void => {
    activeTabStore.setActiveTabId(toCurlTabId(tabId));
  };
}

export const curlTabStore = new CurlTabStore();

export function useCurlTabs(): readonly CurlTabSummary[] {
  return useSyncExternalStore(curlTabStore.subscribe, curlTabStore.getTabs, curlTabStore.getTabs);
}

export function useCurlTabRequest(): CurlTabRequest {
  return useSyncExternalStore(curlTabStore.subscribe, curlTabStore.getRequest, curlTabStore.getRequest);
}

export function useIsCurlActive(): boolean {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    () => isCurlTabId(activeTabStore.getActiveTabId()),
    () => false,
  );
}
