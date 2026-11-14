/**
 * Renderer-side wrapper around the Curl bridge.
 *
 * The bridge speaks a narrow JSON protocol (one resolved wire request in, one
 * shaped response out); this module is the only place that touches it so hooks
 * and components never talk IPC directly.
 */

import type { CurlResponse, CurlSendResult, CurlWireRequest } from '../../domain/models';
import { netcattyBridge } from './netcattyBridge';

const bridge = () => netcattyBridge.get();

function requireHttpBridge() {
  const api = bridge();
  if (!api?.httpRequest) {
    throw new Error('HTTP support is unavailable in this build');
  }
  return api;
}

function normalizeError(value: unknown): { code: string; message: string; detail?: string } {
  if (value && typeof value === 'object') {
    const record = value as { code?: unknown; message?: unknown; detail?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : 'unknown',
      message: typeof record.message === 'string' ? record.message : 'Request failed',
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    };
  }
  return { code: 'unknown', message: typeof value === 'string' ? value : 'Request failed' };
}

function normalizeResponse(value: unknown): CurlResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<CurlResponse>;
  if (typeof record.status !== 'number') return undefined;
  return {
    status: record.status,
    statusText: typeof record.statusText === 'string' ? record.statusText : '',
    httpVersion: record.httpVersion,
    headers: Array.isArray(record.headers) ? record.headers : [],
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
    truncated: record.truncated === true,
    redirects: Array.isArray(record.redirects) ? record.redirects : [],
    contentType: record.contentType,
    bodyKind: record.bodyKind ?? 'empty',
    bodyText: record.bodyText,
    bodyBase64: record.bodyBase64,
  };
}

export async function sendHttpRequest(wire: CurlWireRequest): Promise<CurlSendResult> {
  let raw: unknown;
  try {
    const api = requireHttpBridge();
    raw = await api.httpRequest?.({ wire });
  } catch (error) {
    // A missing bridge or a failed IPC round-trip is still a result the UI can
    // show; throwing here used to leave the tab stuck in "sending".
    return {
      ok: false,
      error: { code: 'unknown', message: error instanceof Error ? error.message : String(error) },
    };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { code: 'unknown', message: 'No response from HTTP bridge' } };
  }
  const record = raw as { ok?: boolean; response?: unknown; error?: unknown };
  if (record.ok === true) {
    const response = normalizeResponse(record.response);
    if (!response) {
      return { ok: false, error: { code: 'unknown', message: 'Malformed HTTP response' } };
    }
    return { ok: true, response };
  }
  return { ok: false, error: normalizeError(record.error) };
}

export async function cancelHttpRequest(requestId: string): Promise<void> {
  const api = bridge();
  if (!api?.httpCancel) return;
  try {
    await api.httpCancel({ requestId });
  } catch {
    // Best effort: the renderer has already stopped waiting for this request.
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  'invalid-request': 'The request is missing a URL.',
  'invalid-url': 'That URL is not valid.',
  'too-many-redirects': 'Too many redirects.',
  timeout: 'The request timed out.',
  dns: 'Could not resolve the host name.',
  tls: 'TLS handshake failed (certificate or protocol problem).',
  connection: 'Could not connect to the server.',
  cancelled: 'Request cancelled.',
};

export function formatHttpError(error: { code: string; message: string; detail?: string }): string {
  const mapped = ERROR_MESSAGES[error.code];
  if (mapped) return error.detail ? `${mapped} (${error.detail})` : mapped;
  return error.message;
}
