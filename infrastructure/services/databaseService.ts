/**
 * Renderer-side wrapper around the database bridge.
 *
 * The bridge speaks a narrow JSON protocol; this module turns vault entities
 * into connection targets (resolving the stored password placeholder) and keeps
 * error shaping in one place so the UI never needs to understand driver errors.
 */

import { databaseConnectionTarget } from '../../domain/models';
import type {
  DbConnectionTarget,
  DbExecResult,
  DbQueryResult,
  DbTestConnectionResult,
} from '../../domain/models';
import { netcattyBridge } from './netcattyBridge';

export type DbBridgeError = {
  message: string;
  code?: string;
  sqlState?: string;
  position?: number;
  detail?: string;
  hint?: string;
};

const bridge = () => netcattyBridge.get();

function requireDbBridge() {
  const api = bridge();
  if (!api?.dbQuery) {
    throw new Error('Database support is unavailable in this build');
  }
  return api;
}

function normalizeConnectResult(value: unknown): DbTestConnectionResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, durationMs: 0, error: 'No response from database bridge' };
  }
  const record = value as {
    ok?: boolean;
    durationMs?: number;
    serverVersion?: string;
    error?: string | { message?: string; code?: string; detail?: string };
  };
  const failure = record.error && typeof record.error === 'object' ? record.error : undefined;
  const error =
    typeof record.error === 'string'
      ? record.error
      : typeof failure?.message === 'string'
        ? failure.message
        : undefined;
  return {
    ok: record.ok === true,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    serverVersion: record.serverVersion,
    error,
    ...(typeof failure?.code === 'string' && failure.code ? { errorCode: failure.code } : {}),
    ...(typeof failure?.detail === 'string' && failure.detail ? { errorDetail: failure.detail } : {}),
  };
}

export { databaseConnectionTarget };

/** IPC failures (bridge missing, main process error) become results, never throws. */
const bridgeFailure = (error: unknown): DbBridgeError => ({
  message: error instanceof Error ? error.message : String(error),
  code: 'bridge-error',
});

export async function testDatabaseConnection(
  target: DbConnectionTarget,
): Promise<DbTestConnectionResult> {
  try {
    const api = requireDbBridge();
    return normalizeConnectResult(await api.dbTestConnection?.(target));
  } catch (error) {
    return { ok: false, durationMs: 0, error: bridgeFailure(error).message };
  }
}

export async function openDatabaseConnection(
  target: DbConnectionTarget,
): Promise<DbTestConnectionResult> {
  try {
    const api = requireDbBridge();
    return normalizeConnectResult(await api.dbConnect?.(target));
  } catch (error) {
    return { ok: false, durationMs: 0, error: bridgeFailure(error).message };
  }
}

export type DbQueryResponse =
  | { ok: true; result: DbQueryResult; transactionOpen?: boolean }
  | { ok: false; error: DbBridgeError; transactionOpen?: boolean };

export async function runDatabaseQuery(
  target: DbConnectionTarget,
  sql: string,
  options?: { maxRows?: number; timeoutMs?: number },
): Promise<DbQueryResponse> {
  let response: Awaited<ReturnType<NonNullable<ReturnType<typeof requireDbBridge>['dbQuery']>>> | undefined;
  try {
    const api = requireDbBridge();
    response = await api.dbQuery?.({ target, sql, ...options });
  } catch (error) {
    return { ok: false, error: bridgeFailure(error) };
  }
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  const transaction = typeof response.transactionOpen === 'boolean'
    ? { transactionOpen: response.transactionOpen }
    : {};
  if (!response.ok || !response.result) {
    return { ok: false, error: response.error ?? { message: 'Query failed' }, ...transaction };
  }
  return { ok: true, result: response.result, ...transaction };
}

export interface DbTableRef {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

export interface DbColumnInfo {
  name: string;
  type?: string;
  nullable?: boolean;
  /** Primary-key member; required to edit table rows in place. */
  primaryKey?: boolean;
}

export async function listDatabaseTables(
  target: DbConnectionTarget,
): Promise<{ ok: true; tables: DbTableRef[] } | { ok: false; error: DbBridgeError }> {
  let response: Awaited<ReturnType<NonNullable<ReturnType<typeof requireDbBridge>['dbTables']>>> | undefined;
  try {
    const api = requireDbBridge();
    response = await api.dbTables?.({ target });
  } catch (error) {
    return { ok: false, error: bridgeFailure(error) };
  }
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  if (!response.ok || !response.tables) {
    return { ok: false, error: response.error ?? { message: 'Listing tables failed' } };
  }
  return { ok: true, tables: response.tables };
}

export async function listDatabaseColumns(
  target: DbConnectionTarget,
  table: string,
  schema?: string,
): Promise<{ ok: true; columns: DbColumnInfo[] } | { ok: false; error: DbBridgeError }> {
  let response: Awaited<ReturnType<NonNullable<ReturnType<typeof requireDbBridge>['dbColumns']>>> | undefined;
  try {
    const api = requireDbBridge();
    response = await api.dbColumns?.({ target, schema, table });
  } catch (error) {
    return { ok: false, error: bridgeFailure(error) };
  }
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  if (!response.ok || !response.columns) {
    return { ok: false, error: response.error ?? { message: 'Listing columns failed' } };
  }
  return { ok: true, columns: response.columns };
}

export type DbTransactionAction = 'begin' | 'commit' | 'rollback';

export async function controlDatabaseTransaction(
  target: DbConnectionTarget,
  action: DbTransactionAction,
): Promise<
  | { ok: true; transactionOpen?: boolean }
  | { ok: false; error: DbBridgeError; transactionOpen?: boolean }
> {
  let response: Awaited<ReturnType<NonNullable<ReturnType<typeof requireDbBridge>['dbControl']>>> | undefined;
  try {
    const api = requireDbBridge();
    response = await api.dbControl?.({ target, action });
  } catch (error) {
    return { ok: false, error: bridgeFailure(error) };
  }
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  const transaction = typeof response.transactionOpen === 'boolean'
    ? { transactionOpen: response.transactionOpen }
    : {};
  if (!response.ok) {
    return { ok: false, error: response.error ?? { message: 'Transaction failed' }, ...transaction };
  }
  return { ok: true, ...transaction };
}

export async function cancelDatabaseQuery(connectionId: string): Promise<void> {
  try {
    await bridge()?.dbCancel?.({ id: connectionId });
  } catch {
    // The UI already stopped waiting; the statement may still finish server-side.
  }
}

export async function closeDatabaseConnection(connectionId: string): Promise<void> {
  try {
    await bridge()?.dbDisconnect?.({ id: connectionId });
  } catch {
    // Best effort: the main process also drops sessions on dispose.
  }
}

/** Loads a .sql script the user picked; the main process enforces a 5 MB cap. */
export async function readSqlFile(
  path: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const response = await bridge()?.dbReadSqlFile?.(path);
  if (!response) return { ok: false, error: 'No response from database bridge' };
  if (!response.ok || typeof response.text !== 'string') {
    return { ok: false, error: response.error ?? 'read-failed' };
  }
  return { ok: true, text: response.text };
}

/**
 * Writes a SQL script to disk. With `path` the file is overwritten in place
 * when the user picked it in a dialog during this run; otherwise the native
 * save dialog opens (pre-filled with `path` or `defaultName`). Never throws.
 */
export async function saveSqlFile(options: {
  content: string;
  path?: string;
  defaultName?: string;
}): Promise<{ ok: true; path?: string; canceled?: boolean } | { ok: false; error: string }> {
  try {
    const response = await bridge()?.dbSaveTextFile?.({
      content: options.content,
      ...(options.path ? { path: options.path } : {}),
      ...(options.defaultName ? { defaultName: options.defaultName } : {}),
      filters: [
        { name: 'SQL', extensions: ['sql'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (!response) return { ok: false, error: 'No response from database bridge' };
    if (response.ok !== true) return { ok: false, error: response.error ?? 'write-failed' };
    return { ok: true, path: response.path, canceled: response.canceled };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Saves exported config/SQL through the native save dialog. */
export async function saveDatabaseTextFile(
  defaultName: string,
  content: string,
): Promise<{ ok: true; path?: string; canceled?: boolean } | { ok: false; error: string }> {
  const response = await bridge()?.dbSaveTextFile?.({ defaultName, content });
  if (!response) return { ok: false, error: 'No response from database bridge' };
  if (response.ok !== true) return { ok: false, error: response.error ?? 'write-failed' };
  return { ok: true, path: response.path, canceled: response.canceled };
}

/** Saves a binary export (xlsx) through the native save dialog. */
export async function saveDatabaseBinaryFile(
  defaultName: string,
  base64: string,
): Promise<{ ok: true; path?: string; canceled?: boolean } | { ok: false; error: string }> {
  const response = await bridge()?.dbSaveBinaryFile?.({ defaultName, base64 });
  if (!response) return { ok: false, error: 'No response from database bridge' };
  if (response.ok !== true) return { ok: false, error: response.error ?? 'write-failed' };
  return { ok: true, path: response.path, canceled: response.canceled };
}

/** Driver classes declared by a JDBC jar (META-INF/services/java.sql.Driver). */
export async function readJdbcDriverClasses(jarPath: string): Promise<string[]> {
  try {
    const response = await bridge()?.dbDriverClasses?.({ jarPath });
    return response?.ok && Array.isArray(response.classes) ? response.classes : [];
  } catch {
    return [];
  }
}

export type JavaRuntimeInfo = {
  ok: boolean;
  path?: string;
  version?: string;
  error?: string;
};

/** Asks the main process which Java runtime the JDBC sidecar would launch. */
export async function detectJavaRuntime(javaPath?: string): Promise<JavaRuntimeInfo> {
  try {
    const response = await bridge()?.dbJavaRuntime?.({ javaPath });
    if (response?.ok && response.path) {
      return { ok: true, path: response.path, version: response.version ?? 'java' };
    }
    return { ok: false, error: response?.error ?? 'Java runtime not found' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function disposeDatabaseConnections(): Promise<void> {
  await bridge()?.dbDispose?.();
}

/** Single-line error for toasts and inline messages. */
export function formatDatabaseError(error: DbBridgeError | undefined | null): string {
  if (!error) return 'Unknown database error';
  const parts = [error.message];
  if (error.sqlState) parts.push(`SQLSTATE ${error.sqlState}`);
  else if (error.code) parts.push(error.code);
  if (error.position) parts.push(`position ${error.position}`);
  return parts.join(' · ');
}

export type { DbExecResult };
