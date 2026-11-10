import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Copy, History, Loader2, PanelBottom, PanelRight, Play, Plus, Save, Square, Wand2, X } from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { useHttpClient, type CurlTab } from '../../application/state/useHttpClient';
import { useCurlResponseLayout } from '../../application/state/useCurlResponseLayout';
import type { CurlResponse } from '../../domain/models';
import type { HttpWireWarning } from '../../domain/http/httpWire';
import { useClipboardBackend } from '../../application/state/useClipboardBackend';
import {
  HTTP_METHODS,
  isSensitiveHeaderName,
  type CurlRequest,
  type HttpAuth,
  type HttpBodyKind,
  type HttpKeyValue,
  type HttpMethod,
  type HttpRequestOptions,
} from '../../domain/models';
import type { HttpHistoryEntry } from '../../domain/http/history';
import {
  charsetFromContentType,
  decodeResponseBody,
  formatJsonText,
  minifyJsonText,
  normalizeResponseEncoding,
  RESPONSE_ENCODINGS,
  safeParseJson,
  type ResponseEncoding,
} from '../../domain/http/responseBody';
import {
  composeHttpUrl,
  parseHttpUrl,
  updateHttpUrlParts,
  type HttpUrlParts,
} from '../../domain/http/urlParts';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { toast } from '../ui/toast';
import { CurlHistoryDialog } from './CurlHistoryDialog';
import { copyTextWithFeedback, type ClipboardWriter } from './clipboard';
import { LineNumberedPre, LineNumberedTextarea } from './JsonCodeView';
import { JsonTreeViewer } from './JsonTreeViewer';
import { VerticalSplit } from '../ui/resizable-split';

const DEFAULT_PARTS: HttpUrlParts = { scheme: 'https', host: '', port: null, path: '/', query: '' };

const METHOD_CLASS: Record<HttpMethod, string> = {
  GET: 'text-emerald-500',
  POST: 'text-amber-500',
  PUT: 'text-sky-500',
  PATCH: 'text-fuchsia-500',
  DELETE: 'text-rose-500',
  HEAD: 'text-slate-500',
  OPTIONS: 'text-slate-500',
};

const REQUEST_SECTIONS = ['params', 'headers', 'cookies', 'body', 'auth', 'options'] as const;
type RequestSection = typeof REQUEST_SECTIONS[number];

const RESPONSE_SECTIONS = ['body', 'headers', 'raw'] as const;
type ResponseSection = typeof RESPONSE_SECTIONS[number];

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Bodies above this many characters are shown truncated: laying out an 8 MB
 * single-line <pre> blocks the renderer for seconds. Copy still uses it all.
 */
export const MAX_RENDERED_RESPONSE_CHARS = 2_000_000;

/** Elapsed milliseconds since `startedAt`, ticking while it is set. */
const useElapsedMs = (startedAt: number | undefined): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt ? Math.max(0, now - startedAt) : 0;
};

const formatElapsed = (ms: number): string => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

const statusTone = (status: number): string => {
  if (status >= 500) return 'bg-rose-500/15 text-rose-600 dark:text-rose-400';
  if (status >= 400) return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  if (status >= 300) return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
  return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
};

const KeyValueEditor: React.FC<{
  rows: HttpKeyValue[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  sensitive?: boolean;
  onChange: (rowId: string, patch: Partial<HttpKeyValue>) => void;
  onAdd: () => void;
  onRemove: (rowId: string) => void;
}> = ({ rows, keyPlaceholder, valuePlaceholder, sensitive, onChange, onAdd, onRemove }) => (
  <div className="space-y-2">
    <div className="grid grid-cols-[24px_1fr_1fr_32px] items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
      <span />
      <span>{keyPlaceholder}</span>
      <span>{valuePlaceholder}</span>
      <span />
    </div>
    {rows.map((row) => (
      <div key={row.id} className="grid grid-cols-[24px_1fr_1fr_32px] items-center gap-2">
        <input
          type="checkbox"
          checked={row.enabled}
          onChange={(event) => onChange(row.id, { enabled: event.target.checked })}
          aria-label="toggle row"
          className="h-3.5 w-3.5 accent-primary"
        />
        <Input
          value={row.key}
          placeholder={keyPlaceholder}
          onChange={(event) => onChange(row.id, { key: event.target.value })}
          className="h-8 font-mono text-xs"
        />
        <Input
          value={row.value}
          placeholder={valuePlaceholder}
          type={sensitive && isSensitiveHeaderName(row.key) ? 'password' : 'text'}
          onChange={(event) => onChange(row.id, { value: event.target.value })}
          className="h-8 font-mono text-xs"
        />
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onRemove(row.id)}>
          <X size={14} />
        </Button>
      </div>
    ))}
    <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={onAdd}>
      <Plus size={14} /> {keyPlaceholder}
    </Button>
  </div>
);

const PortInput: React.FC<{
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder: string;
  invalidLabel: string;
}> = ({ value, onChange, placeholder, invalidLabel }) => {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(value === null ? '' : String(value));
    setInvalid(false);
  }, [value]);

  const commit = (next: string) => {
    setText(next);
    if (next.trim() === '') {
      setInvalid(false);
      onChange(null);
      return;
    }
    if (!/^\d+$/.test(next)) {
      setInvalid(true);
      return;
    }
    const parsed = Number(next);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(parsed);
  };

  return (
    <div className="relative w-[92px] shrink-0">
      <Input
        value={text}
        placeholder={placeholder}
        onChange={(event) => commit(event.target.value)}
        className={cn('h-9 font-mono text-xs', invalid && 'border-destructive text-destructive')}
        aria-invalid={invalid || undefined}
        aria-label={placeholder}
      />
      {invalid ? (
        <span className="absolute -bottom-4 left-0 text-[10px] text-destructive">{invalidLabel}</span>
      ) : null}
    </div>
  );
};

const UrlBar: React.FC<{
  tab: CurlTab;
  onUrlChange: (url: string) => void;
  onPartsChange: (patch: Partial<HttpUrlParts>) => void;
  onSubmit: () => void;
  invalidPortLabel: string;
  invalidHostLabel: string;
}> = ({ tab, onUrlChange, onPartsChange, onSubmit, invalidPortLabel, invalidHostLabel }) => {
  const { t } = useI18n();
  const parsed = useMemo(() => parseHttpUrl(tab.draft.url), [tab.draft.url]);
  // tsconfig has strictNullChecks off, so discriminated unions do not narrow here.
  const parts = (parsed as { parts?: HttpUrlParts }).parts ?? DEFAULT_PARTS;
  const urlInvalid = !(parsed as { parts?: HttpUrlParts }).parts && tab.draft.url.trim() !== '';
  const parseFailure = (parsed as { reason?: string }).reason;
  const invalidMessage = parseFailure
    ? parseFailure === 'invalid-port'
      ? invalidPortLabel
      : invalidHostLabel
    : '';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={tab.draft.url}
          placeholder="https://api.example.com/v1/items?page=1"
          onChange={(event) => onUrlChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            onSubmit();
          }}
          className={cn('h-9 flex-1 font-mono text-xs transition-colors', urlInvalid && 'border-destructive')}
          aria-invalid={urlInvalid || undefined}
          data-testid="curl-url-input"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={parts.scheme}
          onValueChange={(value) => onPartsChange({ scheme: value === 'http' ? 'http' : 'https' })}
        >
          <SelectTrigger className="h-9 w-[104px] font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="https">https</SelectItem>
            <SelectItem value="http">http</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={parts.host}
          placeholder={t('curl.url.host')}
          onChange={(event) => onPartsChange({ host: event.target.value })}
          className="h-9 flex-1 min-w-[160px] font-mono text-xs"
          data-testid="curl-host-input"
        />
        <PortInput
          value={parts.port}
          onChange={(port) => onPartsChange({ port })}
          placeholder={t('curl.url.port')}
          invalidLabel={invalidPortLabel}
        />
        <Input
          value={parts.path}
          placeholder={t('curl.url.path')}
          onChange={(event) => onPartsChange({ path: event.target.value })}
          className="h-9 flex-1 min-w-[140px] font-mono text-xs"
          data-testid="curl-path-input"
        />
      </div>
      {urlInvalid ? <p className="text-[11px] text-destructive">{invalidMessage}</p> : null}
    </div>
  );
};

interface ResponsePanelProps {
  response: CurlResponse | undefined;
  status: CurlTab['status'];
  error: string | undefined;
  warnings: HttpWireWarning[] | undefined;
  sentAt: number | undefined;
  completedAt: number | undefined;
  writeClipboard: ClipboardWriter | null;
}

/**
 * Memoized on the response fields: the request editor re-renders the surface
 * on every keystroke, and re-parsing a multi-megabyte JSON body each time made
 * typing in the URL bar lag.
 */
const ResponsePanel = memo(function ResponsePanel({
  response,
  status,
  error,
  warnings,
  sentAt,
  completedAt,
  writeClipboard,
}: ResponsePanelProps) {
  const { t } = useI18n();
  const [section, setSection] = useState<ResponseSection>('body');
  const [encoding, setEncoding] = useState<ResponseEncoding>('auto');
  const [bodyView, setBodyView] = useState<'tree' | 'raw'>('tree');
  const sending = status === 'sending';
  const elapsedMs = useElapsedMs(sending ? sentAt : undefined);

  const effectiveEncoding: ResponseEncoding = useMemo(() => {
    if (encoding !== 'auto') return encoding;
    return charsetFromContentType(response?.contentType) ?? 'utf-8';
  }, [encoding, response?.contentType]);

  const decodedBody = useMemo(() => {
    if (!response) return '';
    return decodeResponseBody(response.bodyBase64, effectiveEncoding) ?? response.bodyText ?? '';
  }, [response, effectiveEncoding]);

  // Parsed once per body: the tree view, the pretty text and the JSON check share it.
  const parsedJson = useMemo(
    () => (response?.bodyKind === 'json' ? safeParseJson(decodedBody) : undefined),
    [decodedBody, response?.bodyKind],
  );
  const isJson = parsedJson !== undefined;
  const prettyBody = useMemo(() => {
    if (!decodedBody) return '';
    if (parsedJson === undefined) return decodedBody;
    try {
      return JSON.stringify(parsedJson, null, 2);
    } catch {
      return decodedBody;
    }
  }, [decodedBody, parsedJson]);
  const renderedBody = useMemo(
    () => (decodedBody.length > MAX_RENDERED_RESPONSE_CHARS
      ? decodedBody.slice(0, MAX_RENDERED_RESPONSE_CHARS)
      : decodedBody),
    [decodedBody],
  );
  const bodyClipped = renderedBody.length < decodedBody.length;

  const progress = sending ? (
    <div className="nc-progress-track shrink-0" role="progressbar" aria-busy="true" aria-label={t('curl.sending')} />
  ) : null;

  if (sending && !response) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {progress}
        <div className="nc-anim-fade-in flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <span className="tabular-nums">{t('curl.sendingElapsed', { seconds: formatElapsed(elapsedMs) })}</span>
        </div>
      </div>
    );
  }
  if (error && !sending) {
    // A user cancel leaves the tab idle with a notice; only real failures shake.
    const userCancelled = status !== 'error';
    return (
      <div className="p-4">
        <div
          key={completedAt}
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            userCancelled
              ? 'nc-anim-fade-in border-border/70 bg-muted/40 text-muted-foreground'
              : 'nc-anim-shake border-destructive/40 bg-destructive/10 text-destructive',
          )}
          role={userCancelled ? 'status' : 'alert'}
        >
          {error}
        </div>
        {warnings && warnings.length > 0 ? (
          <p className="nc-anim-fade-in mt-2 text-xs text-muted-foreground">{t('curl.warnings.droppedBody')}</p>
        ) : null}
      </div>
    );
  }
  if (!response) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('curl.response.empty')}
      </div>
    );
  }

  const isBinary = response.bodyKind === 'binary';
  const copyPayload = decodedBody || response.bodyBase64 || '';

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {progress}
      {sending ? (
        <div className="nc-anim-pop-in pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-border/70 bg-background/95 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm">
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
          <span className="tabular-nums">{t('curl.sendingElapsed', { seconds: formatElapsed(elapsedMs) })}</span>
        </div>
      ) : null}
      <div
        key={completedAt}
        className="nc-anim-fade-in nc-stale-content flex min-h-0 flex-1 flex-col"
        data-stale={sending ? 'true' : undefined}
      >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <span className={cn('nc-anim-pop-in rounded px-2 py-0.5 font-semibold', statusTone(response.status))}>
          {response.status} {response.statusText}
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock size={12} /> {response.durationMs} ms
        </span>
        <span className="text-muted-foreground">{formatBytes(response.sizeBytes)}</span>
        {response.truncated ? (
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400">
            {t('curl.response.truncated')}
          </span>
        ) : null}
        {response.redirects.length > 0 ? (
          <span className="text-muted-foreground">
            {t('curl.response.redirects', { count: response.redirects.length })}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {section === 'body' && !isBinary ? (
            <>
              {isJson ? (
                <div className="flex items-center gap-0.5 rounded border border-border/60 p-0.5">
                  {(['tree', 'raw'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => setBodyView(view)}
                      className={cn(
                        'nc-tab-button rounded px-1.5 py-0.5 text-[11px]',
                        bodyView === view ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(view === 'tree' ? 'curl.body.viewTree' : 'curl.body.viewText')}
                    </button>
                  ))}
                </div>
              ) : null}
              <Select value={encoding} onValueChange={(value) => setEncoding(normalizeResponseEncoding(value))}>
                <SelectTrigger className="h-7 w-[136px] text-[11px]" aria-label={t('curl.response.encoding')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESPONSE_ENCODINGS.map((item) => (
                    <SelectItem key={item} value={item} className="text-xs">
                      {t(`curl.encoding.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() =>
                  void copyTextWithFeedback(
                    writeClipboard,
                    copyPayload,
                    t('curl.response.copied'),
                    t('curl.copyFailed'),
                  )
                }
              >
                <Copy size={12} /> {t('curl.response.copy')}
              </Button>
            </>
          ) : null}
          {RESPONSE_SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setSection(item)}
              className={cn(
                'nc-tab-button rounded px-2 py-1 text-xs',
                section === item ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`curl.response.${item}`)}
            </button>
          ))}
        </div>
      </div>
      {bodyClipped && section !== 'headers' ? (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          {t('curl.response.largeBodyNotice', { size: formatBytes(MAX_RENDERED_RESPONSE_CHARS) })}
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        {section === 'body' ? (
          isBinary ? (
            <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">{t('curl.response.binary')}</pre>
          ) : isJson && bodyView === 'tree' ? (
            <JsonTreeViewer
              text={prettyBody}
              labels={{
                expand: t('curl.json.expand'),
                collapse: t('curl.json.collapse'),
                copyValue: t('curl.json.copyValue'),
                showMore: (remaining) => t('curl.json.showMore', { count: remaining }),
              }}
              onCopyValue={(text) =>
                void copyTextWithFeedback(writeClipboard, text, t('curl.response.copied'), t('curl.copyFailed'))
              }
            />
          ) : (
            <LineNumberedPre
              text={renderedBody}
              className="p-3"
              containerClassName="h-full"
              data-testid="curl-response-body"
            />
          )
        ) : null}
        {section === 'raw' ? (
          <LineNumberedPre
            text={isBinary
              ? (response.bodyBase64 ?? '').slice(0, MAX_RENDERED_RESPONSE_CHARS)
              : renderedBody}
            className="p-3"
            containerClassName="h-full"
            data-testid="curl-response-raw"
          />
        ) : null}
        {section === 'headers' ? (
          <div className="p-3 font-mono text-xs">
            {response.headers.map((header, index) => (
              <div key={`${header.key}-${index}`} className="flex gap-2 border-b border-border/40 py-1 last:border-b-0">
                <span className="w-56 shrink-0 text-muted-foreground">{header.key}</span>
                <span className="break-all">{header.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </ScrollArea>
      </div>
    </div>
  );
});

export const CurlClientSurface: React.FC<{
  tabId: string | null;
  requests: readonly CurlRequest[];
  onUpdateRequests: (next: CurlRequest[]) => void | Promise<void>;
}> = ({ tabId, requests, onUpdateRequests }) => {
  const { t } = useI18n();
  const client = useHttpClient({ requests, onUpdateRequests });
  const { writeClipboardText } = useClipboardBackend();
  const [section, setSection] = useState<RequestSection>('params');
  const [responseLayout, setResponseLayout] = useCurlResponseLayout();
  const [bodyView, setBodyView] = useState<'text' | 'tree'>('text');
  const [historyEntry, setHistoryEntry] = useState<HttpHistoryEntry | null>(null);
  const activeTab = useMemo(
    () => client.tabs.find((tab) => tab.id === tabId) ?? client.tabs[0],
    [client.tabs, tabId],
  );

  useEffect(() => {
    if (tabId && tabId !== client.activeTabId) client.setActiveTabId(tabId);
  }, [tabId, client]);

  const invalidPortLabel = t('curl.url.invalidPort');
  const invalidHostLabel = t('curl.url.invalidHost');

  const onPartsChange = useCallback(
    (patch: Partial<HttpUrlParts>) => {
      if (!activeTab) return;
      const parsed = parseHttpUrl(activeTab.draft.url);
      const base = parsed.ok ? parsed.parts : DEFAULT_PARTS;
      client.setUrl(activeTab.id, composeHttpUrl(updateHttpUrlParts(base, patch)));
    },
    [activeTab, client],
  );

  const onParamsChange = useCallback(
    (rows: HttpKeyValue[]) => {
      if (!activeTab) return;
      const parsed = parseHttpUrl(activeTab.draft.url);
      const base = parsed.ok ? parsed.parts : DEFAULT_PARTS;
      let query = '';
      for (const row of rows) {
        if (!row.enabled) continue;
        if (!row.key && !row.value) continue;
        const pair = row.key ? `${row.key}=${row.value}` : row.value;
        query = query ? `${query}&${pair}` : pair;
      }
      client.patchDraft(activeTab.id, {
        params: rows,
        url: composeHttpUrl({ ...base, query }),
      });
    },
    [activeTab, client],
  );

  if (!activeTab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{t('curl.noTabs')}</p>
        <Button size="sm" variant="outline" className="gap-1" onClick={() => client.openBlank()}>
          <Plus size={14} /> {t('curl.newRequest')}
        </Button>
      </div>
    );
  }

  const tab = activeTab;
  const sending = tab.status === 'sending';
  const bodyIsJson = tab.draft.body.kind === 'json';
  const jsonError = (() => {
    if (!bodyIsJson || !tab.draft.body.text.trim()) return '';
    const formatted = formatJsonText(tab.draft.body.text) as { text?: string; message?: string };
    return formatted.text ? '' : formatted.message ?? 'Invalid JSON';
  })();
  const applyJsonTransform = (transform: typeof formatJsonText) => {
    const result = transform(tab.draft.body.text) as { text?: string; message?: string };
    if (!result.text) {
      toast.error(t('curl.body.invalidJson', { error: result.message ?? 'Invalid JSON' }));
      return;
    }
    client.patchDraft(tab.id, { body: { ...tab.draft.body, text: result.text } });
  };
  const copyBody = () =>
    void copyTextWithFeedback(writeClipboardText, tab.draft.body.text, t('curl.response.copied'), t('curl.copyFailed'));

  const sendActive = () => {
    if (!sending) void client.send(tab.id);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        sendActive();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <Select
          value={tab.draft.method}
          onValueChange={(value) => {
            client.patchDraft(tab.id, { method: value as HttpMethod });
          }}
        >
          <SelectTrigger className={cn('h-9 w-[110px] font-mono text-xs font-semibold', METHOD_CLASS[tab.draft.method])}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((method) => (
              <SelectItem key={method} value={method} className={cn('font-mono', METHOD_CLASS[method])}>
                {method}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          className="h-9 min-w-[76px] gap-1 transition-all"
          onClick={sendActive}
          disabled={sending}
          title={t('curl.sendShortcut')}
          data-testid="curl-send"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {t('curl.send')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-9 gap-1"
          onClick={() => client.cancel(tab.id)}
          disabled={!sending}
        >
          <Square size={14} /> {t('curl.cancel')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-9 gap-1"
          onClick={() => {
            void client.saveTab(tab.id).then(() => toast.success(t('curl.saved')));
          }}
        >
          <Save size={14} /> {t('curl.save')}
        </Button>
        <Input
          value={tab.draft.name}
          placeholder={t('curl.form.name')}
          onChange={(event) => client.patchDraft(tab.id, { name: event.target.value })}
          className="h-9 w-[200px] text-xs"
        />
        <span
          key={tab.dirty ? 'dirty' : 'clean'}
          className={cn(
            'nc-anim-fade-in text-[11px]',
            tab.dirty ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}
        >
          {tab.dirty ? t('curl.unsaved') : t('curl.savedState')}
        </span>

        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="ml-auto h-9 gap-1">
              <History size={14} /> {t('curl.history.title')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[440px] p-0">
            {client.history.entries.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">{t('curl.history.empty')}</p>
            ) : (
              <ScrollArea className="max-h-[360px]">
                <div className="p-1">
                  {client.history.entries.slice(0, 40).map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => setHistoryEntry(entry)}
                    >
                      <span className={cn('w-14 shrink-0 font-mono font-semibold', METHOD_CLASS[entry.method as HttpMethod])}>
                        {entry.method}
                      </span>
                      <span className="truncate font-mono">{entry.url}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{entry.status || '—'}</span>
                      <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground">
                        {new Date(entry.at).toLocaleTimeString()}
                      </span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
            <div className="border-t border-border/60 p-1">
              <Button variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={client.history.clear}>
                {t('curl.history.clear')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="border-b border-border/60 px-3 py-2">
        <UrlBar
          tab={tab}
          onUrlChange={(url) => client.setUrl(tab.id, url)}
          onPartsChange={onPartsChange}
          onSubmit={sendActive}
          invalidPortLabel={invalidPortLabel}
          invalidHostLabel={invalidHostLabel}
        />
      </div>

      <VerticalSplit
        className="flex-1"
        // Each orientation remembers its own ratio; the key also remounts the
        // split so the stored ratio of the new orientation is read.
        key={responseLayout}
        orientation={responseLayout === 'right' ? 'horizontal' : 'vertical'}
        storageKey={responseLayout === 'right' ? 'netcatty.curl.splitRatio.horizontal' : 'netcatty.curl.splitRatio'}
        handleLabel={t('curl.split.resize')}
        testId="curl-split"
        top={
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
            {REQUEST_SECTIONS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setSection(item)}
                className={cn(
                  'nc-tab-button rounded px-2 py-1 text-xs',
                  section === item ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`curl.request.${item}`)}
              </button>
            ))}
            <button
              type="button"
              className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid="curl-response-layout-toggle"
              aria-label={t(responseLayout === 'right' ? 'curl.layout.responseBottom' : 'curl.layout.responseRight')}
              title={t(responseLayout === 'right' ? 'curl.layout.responseBottom' : 'curl.layout.responseRight')}
              onClick={() => setResponseLayout(responseLayout === 'right' ? 'bottom' : 'right')}
            >
              {responseLayout === 'right' ? <PanelBottom size={14} /> : <PanelRight size={14} />}
            </button>
          </div>
          {section === 'body' ? null : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex min-h-full flex-col gap-2 p-3">
              {section === 'params' ? (
                <KeyValueEditor
                  rows={tab.draft.params}
                  keyPlaceholder={t('curl.key')}
                  valuePlaceholder={t('curl.value')}
                  onChange={(rowId, patch) =>
                    onParamsChange(tab.draft.params.map((row) => (row.id === rowId ? { ...row, ...patch } : row)))
                  }
                  onAdd={() =>
                    onParamsChange([
                      ...tab.draft.params,
                      { id: `param-${Date.now()}`, key: '', value: '', enabled: true },
                    ])
                  }
                  onRemove={(rowId) => onParamsChange(tab.draft.params.filter((row) => row.id !== rowId))}
                />
              ) : null}

              {section === 'headers' ? (
                <KeyValueEditor
                  rows={tab.draft.headers}
                  keyPlaceholder={t('curl.key')}
                  valuePlaceholder={t('curl.value')}
                  sensitive
                  onChange={(rowId, patch) => client.updateKeyValue(tab.id, 'headers', rowId, patch)}
                  onAdd={() => client.addKeyValue(tab.id, 'headers')}
                  onRemove={(rowId) => client.removeKeyValue(tab.id, 'headers', rowId)}
                />
              ) : null}

              {section === 'cookies' ? (
                <KeyValueEditor
                  rows={tab.draft.cookies}
                  keyPlaceholder={t('curl.key')}
                  valuePlaceholder={t('curl.value')}
                  sensitive
                  onChange={(rowId, patch) => client.updateKeyValue(tab.id, 'cookies', rowId, patch)}
                  onAdd={() => client.addKeyValue(tab.id, 'cookies')}
                  onRemove={(rowId) => client.removeKeyValue(tab.id, 'cookies', rowId)}
                />
              ) : null}

              

              {section === 'auth' ? (
                <div className="max-w-[520px] space-y-2">
                  <Select
                    value={tab.draft.auth.kind}
                    onValueChange={(value) =>
                      client.patchDraft(tab.id, { auth: { ...tab.draft.auth, kind: value as HttpAuth['kind'] } })
                    }
                  >
                    <SelectTrigger className="h-9 w-[180px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['none', 'basic', 'bearer', 'apiKey'] as HttpAuth['kind'][]).map((kind) => (
                        <SelectItem key={kind} value={kind} className="text-xs">
                          {t(`curl.auth.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {tab.draft.auth.kind === 'basic' ? (
                    <>
                      <Input
                        value={tab.draft.auth.username ?? ''}
                        placeholder={t('curl.auth.username')}
                        onChange={(event) =>
                          client.patchDraft(tab.id, { auth: { ...tab.draft.auth, username: event.target.value } })
                        }
                        className="h-9 text-xs"
                      />
                      <Input
                        type="password"
                        value={tab.draft.auth.password ?? ''}
                        placeholder={t('curl.auth.password')}
                        onChange={(event) =>
                          client.patchDraft(tab.id, { auth: { ...tab.draft.auth, password: event.target.value } })
                        }
                        className="h-9 text-xs"
                      />
                    </>
                  ) : null}
                  {tab.draft.auth.kind === 'bearer' ? (
                    <Input
                      type="password"
                      value={tab.draft.auth.token ?? ''}
                      placeholder={t('curl.auth.token')}
                      onChange={(event) =>
                        client.patchDraft(tab.id, { auth: { ...tab.draft.auth, token: event.target.value } })
                      }
                      className="h-9 text-xs"
                    />
                  ) : null}
                  {tab.draft.auth.kind === 'apiKey' ? (
                    <>
                      <Input
                        value={tab.draft.auth.apiKeyName ?? ''}
                        placeholder={t('curl.auth.apiKeyName')}
                        onChange={(event) =>
                          client.patchDraft(tab.id, { auth: { ...tab.draft.auth, apiKeyName: event.target.value } })
                        }
                        className="h-9 text-xs"
                      />
                      <Input
                        type="password"
                        value={tab.draft.auth.apiKeyValue ?? ''}
                        placeholder={t('curl.auth.apiKeyValue')}
                        onChange={(event) =>
                          client.patchDraft(tab.id, { auth: { ...tab.draft.auth, apiKeyValue: event.target.value } })
                        }
                        className="h-9 text-xs"
                      />
                      <Select
                        value={tab.draft.auth.apiKeyIn ?? 'header'}
                        onValueChange={(value) =>
                          client.patchDraft(tab.id, {
                            auth: { ...tab.draft.auth, apiKeyIn: value === 'query' ? 'query' : 'header' },
                          })
                        }
                      >
                        <SelectTrigger className="h-9 w-[180px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="header">{t('curl.auth.apiKeyInHeader')}</SelectItem>
                          <SelectItem value="query">{t('curl.auth.apiKeyInQuery')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </>
                  ) : null}
                </div>
              ) : null}

              {section === 'options' ? (
                <div className="max-w-[420px] space-y-3 text-xs">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={tab.draft.options.followRedirects}
                      onChange={(event) =>
                        client.patchDraft(tab.id, {
                          options: { ...tab.draft.options, followRedirects: event.target.checked },
                        })
                      }
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    {t('curl.options.followRedirects')}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={tab.draft.options.verifyTls}
                      onChange={(event) =>
                        client.patchDraft(tab.id, {
                          options: { ...tab.draft.options, verifyTls: event.target.checked },
                        })
                      }
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    {t('curl.options.verifyTls')}
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="w-32 text-muted-foreground">{t('curl.options.maxRedirects')}</span>
                    <Input
                      type="number"
                      min={0}
                      max={20}
                      value={tab.draft.options.maxRedirects}
                      onChange={(event) =>
                        client.patchDraft(tab.id, {
                          options: {
                            ...tab.draft.options,
                            maxRedirects: Number(event.target.value) || 0,
                          } as HttpRequestOptions,
                        })
                      }
                      className="h-8 w-24 text-xs"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-32 text-muted-foreground">{t('curl.options.timeout')}</span>
                    <Input
                      type="number"
                      min={1000}
                      max={120000}
                      step={1000}
                      value={tab.draft.options.timeoutMs}
                      onChange={(event) =>
                        client.patchDraft(tab.id, {
                          options: { ...tab.draft.options, timeoutMs: Number(event.target.value) || 30000 },
                        })
                      }
                      className="h-8 w-28 text-xs"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </ScrollArea>
          )}
          {section === 'body' ? (
                // Scrolls on its own: the editor keeps a 200px minimum, so a
                // short pane must scroll instead of spilling over the response.
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={tab.draft.body.kind}
                      onValueChange={(value) =>
                        client.patchDraft(tab.id, { body: { ...tab.draft.body, kind: value as HttpBodyKind } })
                      }
                    >
                      <SelectTrigger className="h-9 w-[160px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['none', 'json', 'text', 'form'] as HttpBodyKind[]).map((kind) => (
                          <SelectItem key={kind} value={kind} className="text-xs">
                            {t(`curl.body.${kind}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {bodyIsJson ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 gap-1 text-xs"
                          onClick={() => applyJsonTransform(formatJsonText)}
                        >
                          <Wand2 size={13} /> {t('curl.body.format')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-9 gap-1 text-xs"
                          onClick={() => applyJsonTransform(minifyJsonText)}
                        >
                          {t('curl.body.minify')}
                        </Button>
                        <div className="flex items-center gap-0.5 rounded border border-border/60 p-0.5">
                          {(['text', 'tree'] as const).map((view) => (
                            <button
                              key={view}
                              type="button"
                              onClick={() => setBodyView(view)}
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[11px]',
                                bodyView === view
                                  ? 'bg-muted text-foreground'
                                  : 'text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {t(view === 'text' ? 'curl.body.viewText' : 'curl.body.viewTree')}
                            </button>
                          ))}
                        </div>
                        <Button variant="ghost" size="sm" className="h-9 gap-1 text-xs" onClick={copyBody}>
                          <Copy size={13} /> {t('curl.response.copy')}
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {jsonError ? (
                    <p className="text-[11px] text-destructive">
                      {t('curl.body.invalidJson', { error: jsonError })}
                    </p>
                  ) : null}
                  {bodyIsJson && bodyView === 'tree' ? (
                    <div className="min-h-[200px] flex-1 overflow-auto rounded border border-border/60">
                      <JsonTreeViewer
                        text={tab.draft.body.text}
                        labels={{
                          expand: t('curl.json.expand'),
                          collapse: t('curl.json.collapse'),
                          copyValue: t('curl.json.copyValue'),
                          showMore: (remaining) => t('curl.json.showMore', { count: remaining }),
                        }}
                        onCopyValue={(text) =>
                          void copyTextWithFeedback(
                            writeClipboardText,
                            text,
                            t('curl.response.copied'),
                            t('curl.copyFailed'),
                          )
                        }
                      />
                    </div>
                  ) : (
                    <LineNumberedTextarea
                      value={tab.draft.body.text}
                      disabled={tab.draft.body.kind === 'none'}
                      placeholder={t('curl.body.placeholder')}
                      onChange={(event) =>
                        client.patchDraft(tab.id, { body: { ...tab.draft.body, text: event.target.value } })
                      }
                      containerClassName="min-h-[200px] flex-1"
                      className="resize-none"
                      data-testid="curl-request-body"
                    />
                  )}
                </div>
              ) : null}
        </div>
        }
        bottom={(
          <ResponsePanel
            response={tab.response}
            status={tab.status}
            error={tab.error}
            warnings={tab.warnings}
            sentAt={tab.sentAt}
            completedAt={tab.completedAt}
            writeClipboard={writeClipboardText}
          />
        )}
      />
      <CurlHistoryDialog
        entry={historyEntry}
        onOpenChange={(open) => {
          if (!open) setHistoryEntry(null);
        }}
        onReplay={(entry) => {
          client.patchDraft(tab.id, { method: entry.method as HttpMethod, url: entry.url });
          client.setUrl(tab.id, entry.url);
          setHistoryEntry(null);
        }}
      />
    </div>
  );
};
