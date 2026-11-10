import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createEmptyCurlRequest,
  sortCurlRequests,
  type CurlRequest,
  type CurlResponse,
  type HttpKeyValue,
} from '../../domain/models';
import { parseHttpUrl, splitQueryString } from '../../domain/http/urlParts';
import {
  buildHttpWireRequest,
  describeCurlRequest,
  type HttpWireWarning,
} from '../../domain/http/httpWire';
import { decodeResponseBody } from '../../domain/http/responseBody';
import {
  errorSnapshotFrom,
  requestSnapshotFrom,
  responseSnapshotFrom,
} from '../../domain/http/history';
import { cancelHttpRequest, sendHttpRequest } from '../../infrastructure/services/httpClientService';
import { useI18n } from '../i18n/I18nProvider';
import { curlTabStore, useCurlTabRequest } from './curlTabStore';
import { useHttpHistory } from './useHttpHistory';

export interface CurlTab {
  id: string;
  /** Saved request id once the tab has been persisted to the vault. */
  requestId?: string;
  draft: CurlRequest;
  dirty: boolean;
  status: 'idle' | 'sending' | 'done' | 'error';
  response?: CurlResponse;
  error?: string;
  warnings?: HttpWireWarning[];
  inFlightId?: string;
  /** Epoch ms when the in-flight request left; drives the elapsed timer. */
  sentAt?: number;
  /** Epoch ms of the last completed attempt; keys the response fade-in. */
  completedAt?: number;
}

export interface UseHttpClientOptions {
  requests: readonly CurlRequest[];
  onUpdateRequests: (next: CurlRequest[]) => void | Promise<void>;
}

export interface UseHttpClientResult {
  tabs: CurlTab[];
  activeTabId: string | null;
  savedRequests: CurlRequest[];
  setActiveTabId: (tabId: string | null) => void;
  openBlank: () => void;
  openSaved: (requestId: string) => void;
  closeTab: (tabId: string) => void;
  deleteSaved: (requestId: string) => void;
  patchDraft: (tabId: string, patch: Partial<CurlRequest>) => void;
  setUrl: (tabId: string, url: string) => void;
  updateKeyValue: (
    tabId: string,
    field: 'headers' | 'cookies',
    rowId: string,
    patch: Partial<HttpKeyValue>,
  ) => void;
  addKeyValue: (tabId: string, field: 'headers' | 'cookies') => void;
  removeKeyValue: (tabId: string, field: 'headers' | 'cookies', rowId: string) => void;
  send: (tabId: string) => Promise<void>;
  cancel: (tabId: string) => void;
  saveTab: (tabId: string) => Promise<void>;
  history: ReturnType<typeof useHttpHistory>;
}

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const cloneRequest = (request: CurlRequest): CurlRequest => JSON.parse(JSON.stringify(request)) as CurlRequest;

const rowsFromUrl = (url: string): HttpKeyValue[] => {
  const parsed = parseHttpUrl(url);
  if (!parsed.ok) return [];
  return splitQueryString(parsed.parts.query).map((row, index) => ({
    id: `param-${index}-${row.key || 'empty'}`,
    key: row.key,
    value: row.value,
    enabled: true,
  }));
};

const titleFor = (request: CurlRequest): string =>
  request.name.trim() || describeCurlRequest(request) || 'New request';

const isSameDraft = (left: CurlRequest, right: CurlRequest): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const HTTP_ERROR_MESSAGE_KEYS: Record<string, string> = {
  'invalid-request': 'curl.errors.invalidRequest',
  'invalid-url': 'curl.errors.invalidUrl',
  'too-many-redirects': 'curl.errors.tooManyRedirects',
  timeout: 'curl.errors.timeout',
  dns: 'curl.errors.dns',
  tls: 'curl.errors.tls',
  connection: 'curl.errors.connection',
  cancelled: 'curl.errors.cancelled',
};

/** Localized one-line message for a bridge error, keeping the driver code as detail. */
export function describeHttpError(
  error: { code: string; message: string; detail?: string },
  t: (key: string) => string,
): string {
  const key = HTTP_ERROR_MESSAGE_KEYS[error.code];
  if (!key) return error.message || t('curl.errors.unknown');
  const base = t(key);
  return error.detail ? `${base} (${error.detail})` : base;
}

export function useHttpClient({ requests, onUpdateRequests }: UseHttpClientOptions): UseHttpClientResult {
  const [tabs, setTabs] = useState<CurlTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const tabsRef = useRef<CurlTab[]>([]);
  /**
   * Tab id -> wire id of the request that is allowed to report back. Updated
   * synchronously, so a double click cannot send twice and a response that
   * lands after cancel / close / a newer send is dropped instead of
   * overwriting newer state.
   */
  const inFlightRef = useRef(new Map<string, string>());
  const requestsRef = useRef<readonly CurlRequest[]>(requests);
  const hydratedRef = useRef(false);
  const activeTabIdRef = useRef<string | null>(null);
  const { t } = useI18n();
  const history = useHttpHistory();

  tabsRef.current = tabs;
  requestsRef.current = requests;
  activeTabIdRef.current = activeTabId;

  const findRequest = useCallback(
    (requestId: string | undefined): CurlRequest | undefined =>
      requestId ? requestsRef.current.find((item) => item.id === requestId) : undefined,
    [],
  );

  const patchTab = useCallback((tabId: string, patch: Partial<CurlTab>) => {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)));
  }, []);

  const setActiveTabId = useCallback((tabId: string | null) => {
    setActiveTabIdState(tabId);
    if (tabId) curlTabStore.markActive(tabId);
  }, []);

  const createTab = useCallback((draft: CurlRequest, requestId?: string): CurlTab => {
    const tab: CurlTab = {
      id: makeId('curltab'),
      draft,
      dirty: !requestId,
      status: 'idle',
      ...(requestId ? { requestId } : {}),
    };
    return tab;
  }, []);

  const openSaved = useCallback(
    (requestId: string) => {
      const existing = tabsRef.current.find((tab) => tab.requestId === requestId);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const saved = findRequest(requestId);
      if (!saved) return;
      const tab = createTab(cloneRequest(saved), saved.id);
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      curlTabStore.activate(tab.id);
    },
    [createTab, findRequest, setActiveTabId],
  );

  const openBlank = useCallback(() => {
    const draft = createEmptyCurlRequest(makeId('req'));
    const tab = createTab(draft);
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    curlTabStore.activate(tab.id);
  }, [createTab, setActiveTabId]);

  const closeTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    const inFlight = inFlightRef.current.get(tabId) ?? tab?.inFlightId;
    inFlightRef.current.delete(tabId);
    if (inFlight) void cancelHttpRequest(inFlight);
    setTabs((current) => {
      const remaining = current.filter((item) => item.id !== tabId);
      if (activeTabIdRef.current === tabId) {
        setActiveTabIdState(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
      }
      return remaining;
    });
  }, []);

  const deleteSaved = useCallback(
    (requestId: string) => {
      void onUpdateRequests(requestsRef.current.filter((item) => item.id !== requestId));
      setTabs((current) =>
        current.map((tab) =>
          tab.requestId === requestId ? { ...tab, requestId: undefined, dirty: true } : tab,
        ),
      );
    },
    [onUpdateRequests],
  );

  const patchDraft = useCallback((tabId: string, patch: Partial<CurlRequest>) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId) return tab;
        const draft = { ...tab.draft, ...patch, updatedAt: Date.now() };
        const saved = requestsRef.current.find((item) => item.id === tab.requestId);
        return { ...tab, draft, dirty: saved ? !isSameDraft(draft, saved) : true };
      }),
    );
  }, []);

  const setUrl = useCallback(
    (tabId: string, url: string) => {
      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== tabId) return tab;
          const parsed = parseHttpUrl(url);
          const draft: CurlRequest = {
            ...tab.draft,
            url,
            params: parsed.ok ? rowsFromUrl(url) : tab.draft.params,
            updatedAt: Date.now(),
          };
          const saved = requestsRef.current.find((item) => item.id === tab.requestId);
          return { ...tab, draft, dirty: saved ? !isSameDraft(draft, saved) : true };
        }),
      );
    },
    [],
  );

  const updateKeyValue = useCallback(
    (tabId: string, field: 'headers' | 'cookies', rowId: string, patch: Partial<HttpKeyValue>) => {
      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== tabId) return tab;
          const rows = tab.draft[field].map((row) => (row.id === rowId ? { ...row, ...patch } : row));
          const next: CurlRequest = { ...tab.draft, [field]: rows, updatedAt: Date.now() };
          const saved = requestsRef.current.find((item) => item.id === tab.requestId);
          return { ...tab, draft: next, dirty: saved ? !isSameDraft(next, saved) : true };
        }),
      );
    },
    [],
  );

  const addKeyValue = useCallback((tabId: string, field: 'headers' | 'cookies') => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              dirty: true,
              draft: {
                ...tab.draft,
                [field]: [
                  ...tab.draft[field],
                  { id: makeId(field === 'headers' ? 'hdr' : 'ck'), key: '', value: '', enabled: true },
                ],
                updatedAt: Date.now(),
              },
            }
          : tab,
      ),
    );
  }, []);

  const removeKeyValue = useCallback((tabId: string, field: 'headers' | 'cookies', rowId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              dirty: true,
              draft: {
                ...tab.draft,
                [field]: tab.draft[field].filter((row) => row.id !== rowId),
                updatedAt: Date.now(),
              },
            }
          : tab,
      ),
    );
  }, []);

  const send = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab || tab.status === 'sending' || inFlightRef.current.has(tabId)) return;
      const wireId = makeId('wire');
      const built = buildHttpWireRequest(tab.draft);
      if (!built.ok) {
        patchTab(tabId, {
          status: 'error',
          error: t('curl.errors.invalidUrl'),
          response: undefined,
          completedAt: Date.now(),
        });
        return;
      }
      inFlightRef.current.set(tabId, wireId);
      patchTab(tabId, {
        status: 'sending',
        error: undefined,
        warnings: built.warnings,
        inFlightId: wireId,
        sentAt: Date.now(),
      });
      const result = await sendHttpRequest({ ...built.wire, id: wireId });
      // Cancelled, closed or superseded while we waited: the caller already moved on.
      if (inFlightRef.current.get(tabId) !== wireId) return;
      inFlightRef.current.delete(tabId);
      const requestSnapshot = requestSnapshotFrom(
        tab.draft.method,
        built.wire.url,
        built.wire.headers,
        tab.draft.body.kind,
        built.wire.bodyText,
      );
      if (result.ok) {
        patchTab(tabId, {
          status: 'done',
          response: result.response,
          error: undefined,
          inFlightId: undefined,
          sentAt: undefined,
          completedAt: Date.now(),
        });
        try {
          const decodedBody =
            result.response.bodyText ?? decodeResponseBody(result.response.bodyBase64, 'utf-8') ?? undefined;
          history.record({
            method: tab.draft.method,
            url: built.wire.url,
            status: result.response.status,
            durationMs: result.response.durationMs,
            request: requestSnapshot,
            response: responseSnapshotFrom(result.response, decodedBody),
          });
        } catch {
          // History is a convenience; it must never turn a good response into an error.
        }
        return;
      }
      const error = (result.ok === false ? result.error : { code: 'unknown', message: 'Request failed' }) as {
        code: string;
        message: string;
        detail?: string;
      };
      patchTab(tabId, {
        status: 'error',
        error: describeHttpError(error, t),
        inFlightId: undefined,
        sentAt: undefined,
        completedAt: Date.now(),
      });
      if (error.code === 'cancelled') return;
      try {
        history.record({
          method: tab.draft.method,
          url: built.wire.url,
          status: 0,
          durationMs: 0,
          request: requestSnapshot,
          response: errorSnapshotFrom(error),
        });
      } catch {
        // see above
      }
    },
    [history, patchTab, t],
  );

  const cancel = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    const inFlight = inFlightRef.current.get(tabId) ?? tab?.inFlightId;
    if (!inFlight) return;
    inFlightRef.current.delete(tabId);
    void cancelHttpRequest(inFlight);
    patchTab(tabId, {
      status: 'idle',
      inFlightId: undefined,
      sentAt: undefined,
      error: t('curl.errors.cancelled'),
      completedAt: Date.now(),
    });
  }, [patchTab, t]);

  const saveTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) return;
      const savedDraft: CurlRequest = {
        ...tab.draft,
        name: tab.draft.name.trim() || titleFor(tab.draft),
        createdAt: tab.requestId ? tab.draft.createdAt : Date.now(),
        updatedAt: Date.now(),
      };
      const existing = requestsRef.current.some((item) => item.id === savedDraft.id);
      const next = existing
        ? requestsRef.current.map((item) => (item.id === savedDraft.id ? savedDraft : item))
        : [...requestsRef.current, savedDraft];
      await onUpdateRequests(next);
      patchTab(tabId, { requestId: savedDraft.id, draft: savedDraft, dirty: false });
    },
    [onUpdateRequests, patchTab],
  );

  // Tearing the surface down abandons every response, so stop the sockets too.
  useEffect(() => {
    const inFlight = inFlightRef.current;
    return () => {
      for (const wireId of inFlight.values()) void cancelHttpRequest(wireId);
      inFlight.clear();
    };
  }, []);

  // Hydrate persisted tabs once the vault has had a chance to load.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const persisted = curlTabStore.loadPersisted();
    if (!persisted || persisted.tabs.length === 0) return;
    const restored: CurlTab[] = persisted.tabs.map((entry) => {
      const saved = savedRequestFromPersisted(entry.requestId, requestsRef.current);
      const draft = saved ? cloneRequest(saved) : createEmptyCurlRequest(entry.requestId ?? makeId('req'));
      return {
        id: entry.id,
        draft,
        dirty: !saved,
        status: 'idle',
        ...(saved ? { requestId: saved.id } : {}),
      };
    });
    setTabs(restored);
    if (persisted.activeTabId && restored.some((tab) => tab.id === persisted.activeTabId)) {
      setActiveTabIdState(persisted.activeTabId);
    }
  }, []);

  // Reload drafts for clean tabs when the vault array changes (sync / import).
  useEffect(() => {
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (!tab.requestId || tab.dirty) return tab;
        const saved = requests.find((item) => item.id === tab.requestId);
        if (!saved || isSameDraft(tab.draft, saved)) return tab;
        changed = true;
        return { ...tab, draft: cloneRequest(saved) };
      });
      return changed ? next : current;
    });
  }, [requests]);

  // Publish summaries to the tab bar + persist tab identity.
  useEffect(() => {
    const summaries = tabs.map((tab) => ({
      id: tab.id,
      title: titleFor(tab.draft),
      method: tab.draft.method,
      status: tab.status,
      dirty: tab.dirty,
      ...(tab.requestId ? { requestId: tab.requestId } : {}),
    }));
    curlTabStore.sync(summaries, activeTabId);
    curlTabStore.saveDrafts(summaries, activeTabId);
  }, [tabs, activeTabId]);

  // Consume open/close requests from the sidebar and the tab bar.
  const request = useCurlTabRequest();
  useEffect(() => {
    if (!request) return;
    if (request.type === 'open') {
      if (request.requestId) openSaved(request.requestId);
      else openBlank();
    } else if (request.type === 'close') {
      closeTab(request.tabId);
    }
    curlTabStore.clearRequest(request.nonce);
  }, [request, openSaved, openBlank, closeTab]);

  const savedRequests = useMemo(() => sortCurlRequests(requests ?? []), [requests]);

  return {
    tabs,
    activeTabId,
    savedRequests,
    setActiveTabId,
    openBlank,
    openSaved,
    closeTab,
    deleteSaved,
    patchDraft,
    setUrl,
    updateKeyValue,
    addKeyValue,
    removeKeyValue,
    send,
    cancel,
    saveTab,
    history,
  };
}

function savedRequestFromPersisted(
  requestId: string | undefined,
  requests: readonly CurlRequest[],
): CurlRequest | undefined {
  if (!requestId) return undefined;
  return requests.find((item) => item.id === requestId);
}

