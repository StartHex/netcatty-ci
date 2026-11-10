/**
 * Models for the built-in Curl tool (HTTP request workspace). Requests are
 * plain data so they can live in the encrypted vault and travel through sync.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = typeof HTTP_METHODS[number];

export type HttpScheme = 'http' | 'https';

export interface HttpKeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export type HttpBodyKind = 'none' | 'json' | 'text' | 'form';

export interface HttpBody {
  kind: HttpBodyKind;
  text: string;
}

export type HttpAuthKind = 'none' | 'basic' | 'bearer' | 'apiKey';

export interface HttpAuth {
  kind: HttpAuthKind;
  username?: string;
  password?: string;
  token?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyIn?: 'header' | 'query';
}

export interface HttpRequestOptions {
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  timeoutMs: number;
}

export interface CurlRequest {
  id: string;
  name: string;
  folder?: string;
  method: HttpMethod;
  /** Authoritative URL text; host/port/path are derived from it. */
  url: string;
  /** View of the URL query (rebuilt from `url`). */
  params: HttpKeyValue[];
  headers: HttpKeyValue[];
  cookies: HttpKeyValue[];
  body: HttpBody;
  auth: HttpAuth;
  options: HttpRequestOptions;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface CurlWireRequest {
  id: string;
  method: HttpMethod;
  url: string;
  headers: Array<{ key: string; value: string }>;
  bodyText?: string;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
}

export type CurlResponseBodyKind = 'text' | 'json' | 'html' | 'xml' | 'binary' | 'empty';

export interface CurlResponse {
  status: number;
  statusText: string;
  httpVersion?: string;
  headers: Array<{ key: string; value: string }>;
  durationMs: number;
  sizeBytes: number;
  truncated: boolean;
  redirects: Array<{ status: number; location: string }>;
  contentType?: string;
  bodyKind: CurlResponseBodyKind;
  bodyText?: string;
  bodyBase64?: string;
}

export interface CurlError {
  code: string;
  message: string;
  detail?: string;
}

export type CurlSendResult =
  | { ok: true; response: CurlResponse }
  | { ok: false; error: CurlError };

export const DEFAULT_HTTP_TIMEOUT_MS = 30000;
export const MAX_HTTP_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_REDIRECTS = 10;
export const MAX_REDIRECTS_LIMIT = 20;

export const SENSITIVE_HEADER_NAMES = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
];

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (SENSITIVE_HEADER_NAMES.includes(normalized)) return true;
  return normalized.includes('token') || normalized.includes('secret') || normalized.includes('api-key');
}

export function createEmptyCurlRequest(id: string, overrides?: Partial<CurlRequest>): CurlRequest {
  const now = Date.now();
  return {
    id,
    name: '',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    cookies: [],
    body: { kind: 'none', text: '' },
    auth: { kind: 'none' },
    options: {
      followRedirects: true,
      maxRedirects: DEFAULT_MAX_REDIRECTS,
      verifyTls: true,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function clampTimeout(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_HTTP_TIMEOUT_MS;
  return Math.min(MAX_HTTP_TIMEOUT_MS, Math.max(1000, Math.round(numeric)));
}

function clampRedirects(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MAX_REDIRECTS;
  return Math.min(MAX_REDIRECTS_LIMIT, Math.max(0, Math.round(numeric)));
}

function sanitizeKeyValues(input: unknown): HttpKeyValue[] {
  if (!Array.isArray(input)) return [];
  const result: HttpKeyValue[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key : '';
    const value = typeof record.value === 'string' ? record.value : '';
    if (!key && !value) continue;
    result.push({
      id: typeof record.id === 'string' && record.id ? record.id : `kv-${result.length}-${key}`,
      key,
      value,
      enabled: record.enabled !== false,
    });
  }
  return result;
}

function sanitizeBodyKind(value: unknown): HttpBodyKind {
  return value === 'json' || value === 'text' || value === 'form' ? value : 'none';
}

function sanitizeAuthKind(value: unknown): HttpAuthKind {
  return value === 'basic' || value === 'bearer' || value === 'apiKey' ? value : 'none';
}

export function sanitizeCurlRequest(input: unknown): CurlRequest | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return undefined;
  const method = HTTP_METHODS.includes(record.method as HttpMethod) ? (record.method as HttpMethod) : 'GET';
  const options = (record.options && typeof record.options === 'object' ? record.options : {}) as Record<string, unknown>;
  const body = (record.body && typeof record.body === 'object' ? record.body : {}) as Record<string, unknown>;
  const auth = (record.auth && typeof record.auth === 'object' ? record.auth : {}) as Record<string, unknown>;
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now();
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : createdAt;
  const sanitized: CurlRequest = {
    id,
    name: typeof record.name === 'string' ? record.name : '',
    method,
    url: typeof record.url === 'string' ? record.url : 'https://',
    params: sanitizeKeyValues(record.params),
    headers: sanitizeKeyValues(record.headers),
    cookies: sanitizeKeyValues(record.cookies),
    body: { kind: sanitizeBodyKind(body.kind), text: typeof body.text === 'string' ? body.text : '' },
    auth: {
      kind: sanitizeAuthKind(auth.kind),
      username: typeof auth.username === 'string' ? auth.username : undefined,
      password: typeof auth.password === 'string' ? auth.password : undefined,
      token: typeof auth.token === 'string' ? auth.token : undefined,
      apiKeyName: typeof auth.apiKeyName === 'string' ? auth.apiKeyName : undefined,
      apiKeyValue: typeof auth.apiKeyValue === 'string' ? auth.apiKeyValue : undefined,
      apiKeyIn: auth.apiKeyIn === 'query' ? 'query' : auth.apiKeyIn === 'header' ? 'header' : undefined,
    },
    options: {
      followRedirects: options.followRedirects !== false,
      maxRedirects: clampRedirects(options.maxRedirects),
      verifyTls: options.verifyTls !== false,
      timeoutMs: clampTimeout(options.timeoutMs),
    },
    createdAt,
    updatedAt,
  };
  if (typeof record.folder === 'string' && record.folder.trim()) sanitized.folder = record.folder.trim();
  if (typeof record.lastUsedAt === 'number') sanitized.lastUsedAt = record.lastUsedAt;
  return sanitized;
}

export function sanitizeCurlRequests(input: unknown): CurlRequest[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: CurlRequest[] = [];
  for (const entry of input) {
    const sanitized = sanitizeCurlRequest(entry);
    if (!sanitized || seen.has(sanitized.id)) continue;
    seen.add(sanitized.id);
    result.push(sanitized);
  }
  return result;
}

export function sortCurlRequests(requests: readonly CurlRequest[]): CurlRequest[] {
  return [...requests].sort((left, right) => {
    const folderCompare = (left.folder ?? '').localeCompare(right.folder ?? '');
    if (folderCompare !== 0) return folderCompare;
    return left.name.localeCompare(right.name);
  });
}

export function curlRequestDisplayTarget(request: CurlRequest): string {
  const withoutScheme = request.url.replace(/^https?:\/\//i, '');
  return withoutScheme.split(/[/?#]/, 1)[0] || request.url;
}

/** Copy safe to upload through cloud sync: encrypted credentials never leave the device. */
export function redactCurlRequestForSync(request: CurlRequest): CurlRequest {
  const headers = request.headers.map((header) =>
    header.value && isSensitiveHeaderName(header.key) ? { ...header, value: '' } : header
  );
  const cookies = request.cookies.map((cookie) => ({ ...cookie, value: '' }));
  return {
    ...request,
    headers,
    cookies,
    auth: {
      ...request.auth,
      password: undefined,
      token: undefined,
      apiKeyValue: undefined,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Curl collection folders                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A curl folder is a plain `/`-separated path (`"team/users"`). The root folder
 * is the empty path, which is why `CurlRequest.folder` stays optional and an
 * empty list entry is normalized away.
 */
export const CURL_FOLDER_SEPARATOR = '/';

/** Deeper trees stop being useful in a sidebar; deeper paths are rejected. */
export const MAX_CURL_FOLDER_SEGMENTS = 6;

function trimFolderSegments(path: string): string[] {
  return path
    .split(CURL_FOLDER_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .slice(0, MAX_CURL_FOLDER_SEGMENTS);
}

/** Split a folder path into trimmed, non-empty segments (max depth clamped). */
export function curlFolderSegments(path: unknown): string[] {
  if (typeof path !== 'string') return [];
  return trimFolderSegments(path);
}

/**
 * Normalize one folder path; returns undefined for the root (empty) path and
 * for paths that exceed `MAX_CURL_FOLDER_SEGMENTS` (reject rather than truncate).
 */
export function sanitizeCurlFolderPath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const rawSegments = path
    .split(CURL_FOLDER_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (rawSegments.length > MAX_CURL_FOLDER_SEGMENTS) return undefined;
  return rawSegments.length > 0 ? rawSegments.join(CURL_FOLDER_SEPARATOR) : undefined;
}

/** Every ancestor folder path of `path`, excluding `path` itself. */
export function curlFolderAncestors(path: string): string[] {
  const segments = curlFolderSegments(path);
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join(CURL_FOLDER_SEPARATOR));
  }
  return ancestors;
}

/**
 * Sanitize the vault-level folder list: trims segments, drops empty paths and
 * paths deeper than `MAX_CURL_FOLDER_SEGMENTS`, dedupes, and keeps every parent
 * path so an empty parent folder still shows up in the tree.
 */
export function sanitizeCurlFolders(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const paths = new Set<string>();
  for (const entry of input) {
    const path = sanitizeCurlFolderPath(entry);
    if (!path) continue;
    paths.add(path);
    for (const ancestor of curlFolderAncestors(path)) paths.add(ancestor);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

/** Parent folder path, or undefined when the folder sits at the root. */
export function curlFolderParentPath(path: string): string | undefined {
  const segments = curlFolderSegments(path);
  if (segments.length <= 1) return undefined;
  return segments.slice(0, -1).join(CURL_FOLDER_SEPARATOR);
}

/** Last path segment (display name) of a folder. */
export function curlFolderLeafName(path: string): string {
  const segments = curlFolderSegments(path);
  return segments[segments.length - 1] ?? '';
}

/** True when `path` is `ancestor` itself or lives below it. */
export function curlFolderIsWithin(path: string, ancestor: string): boolean {
  const target = sanitizeCurlFolderPath(ancestor);
  const source = sanitizeCurlFolderPath(path);
  if (!target || !source) return false;
  return source === target || source.startsWith(`${target}${CURL_FOLDER_SEPARATOR}`);
}

/**
 * Join a parent path and a (possibly multi-segment) folder name. Returns
 * undefined instead of silently truncating when the result exceeds the depth cap.
 */
export function curlFolderJoin(parent: string | undefined, name: string): string | undefined {
  const trimmedName = sanitizeCurlFolderPath(name);
  if (!trimmedName) return undefined;
  const parentPath = sanitizeCurlFolderPath(parent);
  const combined = parentPath ? `${parentPath}${CURL_FOLDER_SEPARATOR}${trimmedName}` : trimmedName;
  const depth = combined.split(CURL_FOLDER_SEPARATOR).filter((segment) => segment.trim().length > 0).length;
  if (depth > MAX_CURL_FOLDER_SEGMENTS) return undefined;
  return sanitizeCurlFolderPath(combined);
}

/**
 * Rewrite a single path that lives at or below `from` to the same position below
 * `to`. Paths outside the subtree are returned unchanged.
 */
export function rewriteCurlFolderPath(
  path: string,
  from: string,
  to: string | undefined,
): string | undefined {
  const source = sanitizeCurlFolderPath(path);
  const origin = sanitizeCurlFolderPath(from);
  if (!source) return undefined;
  if (!origin || !curlFolderIsWithin(source, origin)) return source;
  const suffix = source.slice(origin.length);
  const target = sanitizeCurlFolderPath(to);
  return sanitizeCurlFolderPath(`${target ?? ''}${suffix}`);
}

/** Rewrite every folder path in the vault list (rename / reparent a folder). */
export function rewriteCurlFolders(
  folders: readonly string[],
  from: string,
  to: string | undefined,
): string[] {
  return sanitizeCurlFolders(
    folders.map((folder) => rewriteCurlFolderPath(folder, from, to) ?? ''),
  );
}

/** Remove a folder and its whole subtree from the vault folder list. */
export function removeCurlFolderSubtree(
  folders: readonly string[],
  path: string,
): string[] {
  const target = sanitizeCurlFolderPath(path);
  if (!target) return sanitizeCurlFolders(folders);
  return sanitizeCurlFolders(folders.filter((folder) => !curlFolderIsWithin(folder, target)));
}

/**
 * Move a folder under `parent` (undefined = root). The folder keeps its own name;
 * descendants and requests are rewritten with `rewriteCurlFolderPath`.
 * Returns undefined when the move is impossible (into itself/descendant, too deep).
 */
export function reparentCurlFolderPath(
  path: string,
  parent: string | undefined,
): string | undefined {
  const source = sanitizeCurlFolderPath(path);
  if (!source) return undefined;
  const targetParent = sanitizeCurlFolderPath(parent);
  if (targetParent && curlFolderIsWithin(targetParent, source)) return undefined;
  const segments = curlFolderSegments(source);
  const leaf = segments[segments.length - 1];
  if (!leaf) return undefined;
  const next = curlFolderJoin(targetParent, leaf);
  if (!next || next === source) return undefined;
  return next;
}

/** Rewrite `folder` on every request that lives in (or below) the moved folder. */
export function rewriteCurlRequestFolders(
  requests: readonly CurlRequest[],
  from: string,
  to: string | undefined,
): CurlRequest[] {
  let changed = false;
  const next = requests.map((request) => {
    if (!request.folder) return request;
    const folder = rewriteCurlFolderPath(request.folder, from, to);
    if (!folder || folder === request.folder) return request;
    changed = true;
    return { ...request, folder };
  });
  return changed ? next : [...requests];
}

/**
 * Returns `requests` with a copy of `sourceId` inserted right after it. The
 * copy keeps the folder and every setting, gets `id`, fresh timestamps and a
 * name of the form "<name> <copyLabel>" ("… 2", "… 3" when taken). Returns the
 * input list unchanged when the source does not exist.
 */
export function duplicateCurlRequest(
  requests: readonly CurlRequest[],
  sourceId: string,
  options: { id: string; copyLabel: string; now?: number },
): CurlRequest[] {
  const index = requests.findIndex((request) => request.id === sourceId);
  if (index < 0) return requests as CurlRequest[];
  const source = requests[index];
  const taken = new Set(requests.map((request) => request.name));
  const base = `${source.name || source.url} ${options.copyLabel}`.trim();
  let name = base;
  for (let counter = 2; taken.has(name); counter += 1) name = `${base} ${counter}`;
  const now = options.now ?? Date.now();
  const copy: CurlRequest = {
    ...(JSON.parse(JSON.stringify(source)) as CurlRequest),
    id: options.id,
    name,
    createdAt: now,
    updatedAt: now,
  };
  delete copy.lastUsedAt;
  return [...requests.slice(0, index + 1), copy, ...requests.slice(index + 1)];
}
