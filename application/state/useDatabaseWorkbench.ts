/**
 * Workbench tab state: one tab per opened connection, query lifecycle, and
 * connection health. Kept out of the view so the SQL workbench component stays
 * presentational.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatabaseConnection, DbQueryResult } from '../../domain/models';
import { buildTablePreviewSql } from '../../domain/database/tablePreview';
import { splitSqlStatements } from '../../domain/database/sqlStatements';
import {
  CONNECTION_PROBE_INTERVAL_MS,
  CONNECTION_IDLE_PROBE_MS,
  connectivityProbeSql,
} from '../../domain/database/probe';
import {
  buildDeleteStatement,
  buildUpdateStatement,
  canEditRows,
  parseSingleTableQuery,
  type EditTarget,
} from '../../domain/database/tableEdit';
import {
  cancelDatabaseQuery,
  closeDatabaseConnection,
  databaseConnectionTarget,
  listDatabaseColumns,
  formatDatabaseError,
  openDatabaseConnection,
  controlDatabaseTransaction,
  listDatabaseTables,
  runDatabaseQuery,
  testDatabaseConnection,
  type DbBridgeError,
  type DbColumnInfo,
  type DbTableRef,
} from '../../infrastructure/services/databaseService';
import {
  applyDatabaseTunnel,
  closeAllDatabaseTunnels,
  closeDatabaseTunnel,
  ensureDatabaseTunnel,
  type DatabaseTunnelDeps,
} from '../../infrastructure/services/databaseTunnelService';
import type { DbConnectionTarget, DbTestConnectionResult } from '../../domain/models';
import { useI18n } from '../i18n/I18nProvider';
import { databaseTabStore, useDatabaseTabRequest } from './databaseTabStore';

export type { DatabaseTunnelDeps } from '../../infrastructure/services/databaseTunnelService';
export type { DbColumnInfo, DbTableRef } from '../../infrastructure/services/databaseService';

/** Rows fetched for a statement that carries no LIMIT of its own. */
const FULL_RESULT_ROWS = 10000;

export type DatabaseTabStatus = 'idle' | 'connecting' | 'ready' | 'error';

export interface DatabaseTab {
  id: string;
  connectionId: string;
  title: string;
  kind: DatabaseConnection['kind'];
  sql: string;
  status: DatabaseTabStatus;
  connected: boolean;
  running: boolean;
  serverVersion?: string;
  result?: DbQueryResult;
  error?: string;
  errorDetail?: DbBridgeError;
  durationMs?: number;
  transactionOpen?: boolean;
  tables?: DbTableRef[];
  tablesLoading?: boolean;
  tablesError?: string;
  /** Row cap for the next run (100..5000). */
  maxRows: number;
  /** Column metadata shown by the schema panel's structure view. */
  structure?: { table: DbTableRef; columns: DbColumnInfo[]; loading?: boolean; error?: string };
  /** Set when the current result comes from one table with a usable primary key. */
  editMeta?: { target: EditTarget; columns: DbColumnInfo[] } | null;
  /** Per-tab charset override, applied on top of the connection setting. */
  clientEncoding?: string;
  /** Set when the idle connectivity probe failed: the session is probably dead. */
  offline?: boolean;
  /** Multi-statement runs expose which statement is on the wire right now. */
  executingStatement?: { index: number; total: number; startLine: number; endLine: number } | null;
  /**
   * Set when the last run covered more than one statement: one entry per
   * statement, in execution order. `result`, `error` and `durationMs` above
   * mirror the active entry so every existing consumer keeps working.
   */
  resultSets?: DatabaseResultSet[];
  /** Index into `resultSets` whose result is currently displayed. */
  activeResultIndex?: number;
  /** Epoch ms when the current run started; drives the elapsed timer. */
  runStartedAt?: number;
  /** BEGIN / COMMIT / ROLLBACK in flight. */
  transactionBusy?: boolean;
}

/** One statement's outcome within a multi-statement run. */
export interface DatabaseResultSet {
  /** Statement text that produced this result set. */
  sql: string;
  /** 1-based position in the script, used for the result tab label. */
  index: number;
  /** 1-based line in the editor where the statement starts. */
  startLine: number;
  result?: DbQueryResult;
  error?: string;
  errorDetail?: DbBridgeError;
  durationMs: number;
}

export interface UseDatabaseWorkbenchResult {
  tabs: DatabaseTab[];
  activeTabId: string | null;
  activeTab: DatabaseTab | undefined;
  openTab: (connection: DatabaseConnection, options?: { forceNew?: boolean }) => Promise<string>;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  updateSql: (tabId: string, sql: string) => void;
  runQuery: (tabId: string, sqlOverride?: string, options?: { maxRows?: number }) => Promise<void>;
  setMaxRows: (tabId: string, maxRows: number) => void;
  beginTransaction: (tabId: string) => Promise<void>;
  commitTransaction: (tabId: string) => Promise<void>;
  rollbackTransaction: (tabId: string) => Promise<void>;
  refreshTables: (tabId: string) => Promise<void>;
  previewTable: (tabId: string, table: DbTableRef) => Promise<void>;
  showStructure: (tabId: string, table: DbTableRef) => Promise<void>;
  clearStructure: (tabId: string) => void;
  updateCell: (tabId: string, rowIndex: number, column: string, value: string | null) => Promise<boolean>;
  deleteRow: (tabId: string, rowIndex: number) => Promise<boolean>;
  /** Swap the client charset: drops the session and re-runs the current SQL. */
  setEncoding: (tabId: string, encoding: string) => Promise<void>;
  cancelQuery: (tabId: string) => void;
  reconnect: (tabId: string) => Promise<void>;
  /** Show one statement's result from the last multi-statement run. */
  setActiveResultIndex: (tabId: string, index: number) => void;
}

/**
 * Ad-hoc connection test used by the connection editor. Lives here so components
 * never import infrastructure services directly.
 */
export function useDatabaseConnectionTester(
  tunnelDeps?: DatabaseTunnelDeps,
): { test: (connection: DatabaseConnection) => Promise<DbTestConnectionResult> } {
  const test = useCallback(
    async (connection: DatabaseConnection): Promise<DbTestConnectionResult> => {
      const base = databaseConnectionTarget(connection);
      if (!connection.sshHostId || !tunnelDeps) return testDatabaseConnection(base);
      const tunnel = await ensureDatabaseTunnel(connection, tunnelDeps);
      if (tunnel.ok !== true) return { ok: false, durationMs: 0, error: tunnel.error };
      return testDatabaseConnection(applyDatabaseTunnel(base, { host: tunnel.host, port: tunnel.port }));
    },
    [tunnelDeps],
  );
  return { test };
}

/** Bridge error codes that deserve a translated message instead of the driver text. */
const DB_ERROR_MESSAGE_KEYS: Record<string, string> = {
  'query-cancelled': 'databases.workbench.queryCancelled',
  'query-timeout': 'databases.workbench.queryTimeout',
  'transaction-lost': 'databases.workbench.transactionLost',
  'connect-timeout': 'databases.workbench.connectTimeout',
};

export function describeDatabaseError(
  error: DbBridgeError | undefined | null,
  t: (key: string) => string,
): string {
  const key = error?.code ? DB_ERROR_MESSAGE_KEYS[error.code] : undefined;
  if (key) {
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return formatDatabaseError(error);
}

export function useDatabaseWorkbench(
  connections: DatabaseConnection[],
  tunnelDeps?: DatabaseTunnelDeps,
): UseDatabaseWorkbenchResult {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<DatabaseTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const tabsRef = useRef<DatabaseTab[]>(tabs);
  /**
   * Per-tab run token. Cancel and every new run bump it, so a statement that
   * comes back after the user moved on is dropped instead of overwriting the
   * newer state (or re-enabling "running" for the wrong run).
   */
  const runTokensRef = useRef(new Map<string, number>());
  /** Synchronous double-run guard (state updates land a render later). */
  const runningRef = useRef(new Set<string>());
  const structureTokensRef = useRef(new Map<string, number>());
  const tRef = useRef(t);
  tRef.current = t;

  const beginRun = useCallback((tabId: string): number => {
    const token = (runTokensRef.current.get(tabId) ?? 0) + 1;
    runTokensRef.current.set(tabId, token);
    return token;
  }, []);
  const isCurrentRun = useCallback(
    (tabId: string, token: number): boolean => runTokensRef.current.get(tabId) === token,
    [],
  );
  const describeError = useCallback(
    (error: DbBridgeError | undefined | null) => describeDatabaseError(error, tRef.current),
    [],
  );

  const lastActivityRef = useRef(new Map<string, number>());
  const probingRef = useRef(new Set<string>());

  const touchActivity = useCallback((connectionId: string) => {
    lastActivityRef.current.set(connectionId, Date.now());
  }, []);

  const connectionsRef = useRef<DatabaseConnection[]>(connections);
  const openSeqRef = useRef(new Map<string, number>());
  tabsRef.current = tabs;
  connectionsRef.current = connections;

  const patchTab = useCallback(
    (tabId: string, patch: Partial<DatabaseTab> | ((tab: DatabaseTab) => Partial<DatabaseTab>)) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) }
            : tab,
        ),
      );
    },
    [],
  );

  const setActiveTabId = useCallback((tabId: string | null) => {
    setActiveTabIdState(tabId);
  }, []);

  const tunnelDepsRef = useRef(tunnelDeps);
  tunnelDepsRef.current = tunnelDeps;

  /** Resolve the dialable target, opening an SSH tunnel when the connection asks for one. */
  const resolveTarget = useCallback(
    async (
      connection: DatabaseConnection,
      encodingOverride?: string,
    ): Promise<{ ok: true; target: DbConnectionTarget } | { ok: false; error: string }> => {
      const base = databaseConnectionTarget(connection);
      const withEncoding = encodingOverride
        ? { ...base, clientEncoding: encodingOverride }
        : base;
      const deps = tunnelDepsRef.current;
      if (!connection.sshHostId || !deps) return { ok: true, target: withEncoding };
      const tunnel = await ensureDatabaseTunnel(
        encodingOverride ? { ...connection, clientEncoding: encodingOverride } : connection,
        deps,
      );
      if (tunnel.ok !== true) return { ok: false, error: tunnel.error };
      return {
        ok: true,
        target: applyDatabaseTunnel(withEncoding, { host: tunnel.host, port: tunnel.port }),
      };
    },
    [],
  );

  const loadTables = useCallback(
    async (tabId: string, connection: DatabaseConnection) => {
      patchTab(tabId, { tablesLoading: true, tablesError: undefined });
      try {
        const tabEncoding = tabsRef.current.find((entry) => entry.id === tabId)?.clientEncoding;
        const resolved = await resolveTarget(connection, tabEncoding);
        if (resolved.ok !== true) {
          patchTab(tabId, { tablesLoading: false, tablesError: resolved.error });
          return;
        }
        const response = await listDatabaseTables(resolved.target);
        if (response.ok === true) {
          patchTab(tabId, { tablesLoading: false, tables: response.tables });
        } else {
          patchTab(tabId, {
            tablesLoading: false,
            tablesError: describeError(response.error),
          });
        }
      } catch (error) {
        // A thrown tunnel/IPC error must not leave the schema spinner running.
        patchTab(tabId, {
          tablesLoading: false,
          tablesError: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [describeError, patchTab, resolveTarget],
  );

  const refreshTables = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (tab) {
        touchActivity(tab.connectionId);
        patchTab(tabId, { offline: false });
      }
      if (!tab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) return;
      await loadTables(tabId, connection);
    },
    [loadTables, patchTab, touchActivity],
  );

  const previewTable = useCallback(
    async (tabId: string, table: DbTableRef) => {
      const activeTab = tabsRef.current.find((entry) => entry.id === tabId);
      const sql = buildTablePreviewSql(activeTab?.kind, table, activeTab?.maxRows ?? 1000);
      // Append the generated statement instead of replacing whatever the user
      // already wrote; only the new statement runs.
      const existing = (activeTab?.sql ?? '').replace(/\s+$/, '');
      patchTab(tabId, { sql: existing ? `${existing}\n\n${sql}` : sql });
      if (!activeTab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === activeTab.connectionId);
      if (!connection) return;
      if (activeTab.running || runningRef.current.has(tabId)) return;
      // Run through the same path as the toolbar button.
      const token = beginRun(tabId);
      runningRef.current.add(tabId);
      const startedAt = Date.now();
      patchTab(tabId, {
        running: true,
        runStartedAt: startedAt,
        structure: undefined,
        error: undefined,
        errorDetail: undefined,
      });
      try {
        const resolved = await resolveTarget(connection, activeTab.clientEncoding);
        if (!isCurrentRun(tabId, token)) return;
        if (resolved.ok !== true) {
          patchTab(tabId, { running: false, runStartedAt: undefined, error: resolved.error });
          return;
        }
        const response = await runDatabaseQuery(resolved.target, sql);
        if (!isCurrentRun(tabId, token)) return;
        const transaction = typeof response.transactionOpen === 'boolean'
          ? { transactionOpen: response.transactionOpen }
          : {};
        if (response.ok === true && response.result) {
          patchTab(tabId, {
            running: false,
            runStartedAt: undefined,
            result: response.result,
            resultSets: undefined,
            activeResultIndex: undefined,
            editMeta: null,
            durationMs: Date.now() - startedAt,
            error: undefined,
            errorDetail: undefined,
            ...transaction,
          });
        } else {
          const failureInfo = (response as { error?: DbBridgeError }).error;
          patchTab(tabId, {
            running: false,
            runStartedAt: undefined,
            error: describeError(failureInfo),
            errorDetail: failureInfo,
            ...transaction,
          });
        }
      } catch (error) {
        if (!isCurrentRun(tabId, token)) return;
        patchTab(tabId, {
          running: false,
          runStartedAt: undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (isCurrentRun(tabId, token)) runningRef.current.delete(tabId);
      }
    },
    [beginRun, describeError, isCurrentRun, patchTab, resolveTarget],
  );

  const showStructure = useCallback(
    async (tabId: string, table: DbTableRef) => {
      const activeTab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!activeTab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === activeTab.connectionId);
      if (!connection) return;
      patchTab(tabId, { structure: { table, columns: [], loading: true } });
      // Only the latest structure request may write its result.
      const token = (structureTokensRef.current.get(tabId) ?? 0) + 1;
      structureTokensRef.current.set(tabId, token);
      const isLatest = () => structureTokensRef.current.get(tabId) === token;
      try {
        const resolved = await resolveTarget(connection, activeTab.clientEncoding);
        if (!isLatest()) return;
        if (resolved.ok !== true) {
          patchTab(tabId, { structure: { table, columns: [], error: resolved.error } });
          return;
        }
        const response = await listDatabaseColumns(resolved.target, table.name, table.schema);
        if (!isLatest()) return;
        if (response.ok === true) {
          patchTab(tabId, { structure: { table, columns: response.columns } });
        } else {
          patchTab(tabId, {
            structure: { table, columns: [], error: describeError(response.error) },
          });
        }
      } catch (error) {
        if (!isLatest()) return;
        patchTab(tabId, {
          structure: { table, columns: [], error: error instanceof Error ? error.message : String(error) },
        });
      }
    },
    [describeError, patchTab, resolveTarget],
  );

  const clearStructure = useCallback(
    (tabId: string) => {
      structureTokensRef.current.set(tabId, (structureTokensRef.current.get(tabId) ?? 0) + 1);
      patchTab(tabId, { structure: undefined });
    },
    [patchTab],
  );

  const connectTab = useCallback(
    async (tabId: string, connection: DatabaseConnection) => {
      const seq = (openSeqRef.current.get(tabId) ?? 0) + 1;
      openSeqRef.current.set(tabId, seq);
      patchTab(tabId, { status: 'connecting', error: undefined, errorDetail: undefined });
      const connectEncoding = tabsRef.current.find((entry) => entry.id === tabId)?.clientEncoding;
      try {
        const resolved = await resolveTarget(connection, connectEncoding);
        if (openSeqRef.current.get(tabId) !== seq) return;
        if (resolved.ok !== true) {
          patchTab(tabId, { status: 'error', connected: false, error: resolved.error });
          return;
        }
        const result = await openDatabaseConnection(resolved.target);
        if (openSeqRef.current.get(tabId) !== seq) return;
        if (!result.ok) {
          patchTab(tabId, {
            status: 'error',
            connected: false,
            error: result.error ?? 'Connection failed',
          });
          return;
        }
        patchTab(tabId, {
          status: 'ready',
          connected: true,
          serverVersion: result.serverVersion,
          error: undefined,
          errorDetail: undefined,
        });
        void loadTables(tabId, connection);
      } catch (error) {
        if (openSeqRef.current.get(tabId) !== seq) return;
        patchTab(tabId, {
          status: 'error',
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [loadTables, patchTab, resolveTarget],
  );

  const openTab = useCallback(
    async (connection: DatabaseConnection, options?: { forceNew?: boolean }) => {
      const existing = options?.forceNew
        ? undefined
        : tabsRef.current.find((tab) => tab.connectionId === connection.id);
      if (existing) {
        setActiveTabIdState(existing.id);
        return existing.id;
      }
      const id = crypto.randomUUID();
      setTabs((prev) => [
        ...prev,
        {
          id,
          connectionId: connection.id,
          title: connection.label,
          kind: connection.kind,
          sql: '',
          status: 'connecting',
          connected: false,
          running: false,
          maxRows: 1000,
        },
      ]);
      setActiveTabIdState(id);
      await connectTab(id, connection);
      return id;
    },
    [connectTab],
  );

  const closeTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    runTokensRef.current.delete(tabId);
    runningRef.current.delete(tabId);
    structureTokensRef.current.delete(tabId);
    setTabs((prev) => {
      const next = prev.filter((entry) => entry.id !== tabId);
      setActiveTabIdState((current) => {
        if (current !== tabId) return current;
        return next.length > 0 ? next[next.length - 1].id : null;
      });
      return next;
    });
    if (!tab) return;
    // Tabs opened with "new tab" share one pooled session (and tunnel) per
    // connection: closing one of them must not kill the others' session or
    // their open transaction.
    const stillUsed = tabsRef.current.some(
      (entry) => entry.id !== tabId && entry.connectionId === tab.connectionId,
    );
    if (stillUsed) {
      if (tab.running) void cancelDatabaseQuery(tab.connectionId);
      return;
    }
    void closeDatabaseConnection(tab.connectionId);
    void closeDatabaseTunnel(tab.connectionId);
  }, []);

  const updateSql = useCallback(
    (tabId: string, sql: string) => {
      patchTab(tabId, { sql });
    },
    [patchTab],
  );

  const setMaxRows = useCallback(
    (tabId: string, maxRows: number) => {
      const clamped = Math.min(5000, Math.max(1, Math.round(maxRows)));
      patchTab(tabId, { maxRows: clamped });
    },
    [patchTab],
  );

  const resolveEditMeta = useCallback(
    async (tabId: string, target: DbConnectionTarget, table: EditTarget) => {
      const expected = tabsRef.current.find((entry) => entry.id === tabId)?.result;
      try {
        const response = await listDatabaseColumns(target, table.table, table.schema);
        const current = tabsRef.current.find((entry) => entry.id === tabId);
        if (!current || current.result !== expected) return;
        if (response.ok === true && canEditRows(response.columns)) {
          patchTab(tabId, { editMeta: { target: table, columns: response.columns } });
        }
      } catch {
        // Editing is optional: metadata failures just leave the grid read-only.
      }
    },
    [patchTab],
  );

  /** Runs one row-level mutation through the same tunnel/session path as queries. */
  const runMutation = useCallback(
    async (tabId: string, build: (tab: DatabaseTab) => string | null): Promise<boolean> => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return false;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection || connection.readOnly) return false;
      const sql = build(tab);
      if (!sql) return false;
      touchActivity(tab.connectionId);
      try {
        const resolved = await resolveTarget(connection, tab.clientEncoding);
        if (resolved.ok !== true) {
          patchTab(tabId, { error: resolved.error });
          return false;
        }
        const response = await runDatabaseQuery(resolved.target, sql, { maxRows: 1 });
        const transaction = typeof response.transactionOpen === 'boolean'
          ? { transactionOpen: response.transactionOpen }
          : {};
        if (response.ok !== true) {
          const bridgeError = response.error;
          patchTab(tabId, { error: describeError(bridgeError), errorDetail: bridgeError, ...transaction });
          return false;
        }
        patchTab(tabId, { error: undefined, errorDetail: undefined, ...transaction });
        return true;
      } catch (error) {
        patchTab(tabId, { error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    [describeError, patchTab, resolveTarget, touchActivity],
  );

  const updateCell = useCallback(
    async (tabId: string, rowIndex: number, column: string, value: string | null): Promise<boolean> => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab?.editMeta || !tab.result) return false;
      const resultColumns = tab.result.columns.map((entry) => entry.name);
      const row = tab.result.rows[rowIndex];
      if (!row) return false;
      const sql = buildUpdateStatement({
        target: tab.editMeta.target,
        kind: tab.kind,
        columns: tab.editMeta.columns,
        resultColumns,
        row,
        column,
        value,
      });
      if (!sql) return false;
      const applied = await runMutation(tabId, () => sql);
      if (!applied) return false;
      patchTab(tabId, (current) => {
        if (!current.result) return {};
        const columnIndex = current.result.columns.findIndex(
          (entry) => entry.name.toLowerCase() === column.toLowerCase(),
        );
        if (columnIndex < 0) return {};
        return {
          result: {
            ...current.result,
            rows: current.result.rows.map((entry, index) =>
              index === rowIndex
                ? entry.map((cell, cellIndex) => (cellIndex === columnIndex ? value : cell))
                : entry,
            ),
          },
        };
      });
      return true;
    },
    [patchTab, runMutation],
  );

  const deleteRow = useCallback(
    async (tabId: string, rowIndex: number): Promise<boolean> => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab?.editMeta || !tab.result) return false;
      const resultColumns = tab.result.columns.map((entry) => entry.name);
      const row = tab.result.rows[rowIndex];
      if (!row) return false;
      const sql = buildDeleteStatement({
        target: tab.editMeta.target,
        kind: tab.kind,
        columns: tab.editMeta.columns,
        resultColumns,
        row,
      });
      if (!sql) return false;
      const applied = await runMutation(tabId, () => sql);
      if (!applied) return false;
      patchTab(tabId, (current) => {
        if (!current.result) return {};
        const rows = current.result.rows.filter((_, index) => index !== rowIndex);
        return {
          result: {
            ...current.result,
            rows,
            rowCount: Math.max(0, current.result.rowCount - 1),
          },
          editMeta: rows.length === 0 ? null : current.editMeta,
        };
      });
      return true;
    },
    [patchTab, runMutation],
  );

  /** Mirrors one result set of a multi-statement run into the tab fields. */
  const showResultSet = useCallback(
    (tabId: string, resultSets: DatabaseResultSet[], index: number) => {
      const active = resultSets[index] ?? resultSets[0];
      if (!active) return;
      patchTab(tabId, {
        resultSets,
        activeResultIndex: Math.max(0, Math.min(index, resultSets.length - 1)),
        result: active.result,
        error: active.error,
        errorDetail: active.errorDetail,
        durationMs: active.durationMs,
        status: active.error ? 'error' : 'ready',
        connected: true,
        editMeta: null,
      });
    },
    [patchTab],
  );

  // A dropped VPN or a server-side idle timeout leaves the pooled session dead
  // without telling us. Probe idle connections so the tab can show "offline"
  // before the next query fails.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const tab of tabsRef.current) {
        if (tab.running || probingRef.current.has(tab.connectionId)) continue;
        // A probe would dial a tab the user never connected, and inside an
        // aborted PostgreSQL transaction "select 1" fails although the
        // session is alive; the next real statement reports either case.
        if (!tab.connected || tab.transactionOpen) continue;
        const last = lastActivityRef.current.get(tab.connectionId) ?? now;
        if (now - last < CONNECTION_IDLE_PROBE_MS) continue;
        const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
        if (!connection) continue;
        probingRef.current.add(tab.connectionId);
        void (async () => {
          try {
            const resolved = await resolveTarget(connection, tab.clientEncoding);
            if (resolved.ok !== true) {
              patchTab(tab.id, { offline: true });
              return;
            }
            const response = await runDatabaseQuery(resolved.target, connectivityProbeSql(tab.kind), {
              maxRows: 1,
            });
            patchTab(tab.id, { offline: response.ok !== true });
          } catch {
            patchTab(tab.id, { offline: true });
          } finally {
            probingRef.current.delete(tab.connectionId);
            lastActivityRef.current.set(tab.connectionId, Date.now());
          }
        })();
      }
    }, CONNECTION_PROBE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [patchTab, resolveTarget]);

  const runQuery = useCallback(
    async (
      tabId: string,
      sqlOverride?: string,
      options?: { maxRows?: number; clientEncoding?: string },
    ) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab || tab.running || runningRef.current.has(tabId)) return;
      touchActivity(tab.connectionId);
      if (tab.offline) patchTab(tabId, { offline: false });
      const sql = (sqlOverride ?? tab.sql).trim();
      if (!sql) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) {
        patchTab(tabId, { error: 'Connection was deleted', errorDetail: undefined });
        return;
      }
      const statements = splitSqlStatements(sql);
      if (statements.length === 0) return;
      const token = beginRun(tabId);
      runningRef.current.add(tabId);
      const startedAt = Date.now();
      patchTab(tabId, {
        running: true,
        runStartedAt: startedAt,
        structure: undefined,
        error: undefined,
        errorDetail: undefined,
        resultSets: undefined,
        activeResultIndex: undefined,
        executingStatement: null,
      });
      const runEncoding = options?.clientEncoding
        ?? tabsRef.current.find((entry) => entry.id === tabId)?.clientEncoding;
      // The bridge reports the session's transaction state with every answer.
      const transactionPatch = (response: { transactionOpen?: boolean }) =>
        typeof response.transactionOpen === 'boolean' ? { transactionOpen: response.transactionOpen } : {};
      try {
        const resolved = await resolveTarget(connection, runEncoding);
        if (!isCurrentRun(tabId, token)) return;
        if (resolved.ok !== true) {
          patchTab(tabId, {
            running: false,
            runStartedAt: undefined,
            executingStatement: null,
            error: resolved.error,
          });
          return;
        }
        // Statements without their own LIMIT load a full page set so the grid
        // can paginate client-side; tab.maxRows is the page size, not a cap.
        const maxRows = options?.maxRows ?? FULL_RESULT_ROWS;

        if (statements.length === 1) {
          const statement = statements[0];
          patchTab(tabId, {
            executingStatement: {
              index: 1,
              total: 1,
              startLine: statement.startLine,
              endLine: statement.startLine + (statement.sql.match(/\n/g)?.length ?? 0),
            },
          });
          const response = await runDatabaseQuery(resolved.target, statement.sql, { maxRows });
          if (!isCurrentRun(tabId, token)) return;
          if (response.ok === true && response.result) {
            patchTab(tabId, {
              running: false,
              runStartedAt: undefined,
              executingStatement: null,
              status: 'ready',
              connected: true,
              result: response.result,
              durationMs: Date.now() - startedAt,
              error: undefined,
              errorDetail: undefined,
              editMeta: null,
              ...transactionPatch(response),
            });
            const editableTable = parseSingleTableQuery(statement.sql);
            if (editableTable && response.result.columns.length > 0) {
              void resolveEditMeta(tabId, resolved.target, editableTable);
            }
          } else {
            const bridgeError = response.ok === false ? response.error : undefined;
            patchTab(tabId, {
              running: false,
              runStartedAt: undefined,
              executingStatement: null,
              error: describeError(bridgeError),
              errorDetail: bridgeError,
              ...transactionPatch(response),
            });
          }
          return;
        }

        // Multi-statement script: the sidecar runs one statement per call, so
        // execute them in order and keep every result set for the result tabs.
        // Execution stops at the first failure — later statements usually
        // depend on the failed one, and a partial script is easier to reason
        // about than a cascade of follow-up errors.
        const resultSets: DatabaseResultSet[] = [];
        let stopReason: string | undefined;
        let transactionState: { transactionOpen?: boolean } = {};
        for (const statement of statements) {
          // Cancel / close stop the script between statements, not just the current one.
          if (!isCurrentRun(tabId, token)) return;
          const statementStartedAt = Date.now();
          patchTab(tabId, {
            executingStatement: {
              index: resultSets.length + 1,
              total: statements.length,
              startLine: statement.startLine,
              endLine: statement.startLine + (statement.sql.match(/\n/g)?.length ?? 0),
            },
          });
          const response = await runDatabaseQuery(resolved.target, statement.sql, { maxRows });
          if (!isCurrentRun(tabId, token)) return;
          transactionState = { ...transactionState, ...transactionPatch(response) };
          if (response.ok === true && response.result) {
            resultSets.push({
              sql: statement.sql,
              index: resultSets.length + 1,
              startLine: statement.startLine,
              result: response.result,
              durationMs: Date.now() - statementStartedAt,
            });
            continue;
          }
          const bridgeError = response.ok === false ? response.error : undefined;
          resultSets.push({
            sql: statement.sql,
            index: resultSets.length + 1,
            startLine: statement.startLine,
            error: describeError(bridgeError),
            errorDetail: bridgeError,
            durationMs: Date.now() - statementStartedAt,
          });
          stopReason = describeError(bridgeError);
          break;
        }
        patchTab(tabId, { running: false, runStartedAt: undefined, executingStatement: null, ...transactionState });
        showResultSet(tabId, resultSets, 0);
        if (stopReason) {
          patchTab(tabId, { error: stopReason, errorDetail: resultSets[resultSets.length - 1]?.errorDetail });
        }
      } catch (error) {
        if (!isCurrentRun(tabId, token)) return;
        patchTab(tabId, {
          running: false,
          runStartedAt: undefined,
          executingStatement: null,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (isCurrentRun(tabId, token)) runningRef.current.delete(tabId);
      }
    },
    [beginRun, describeError, isCurrentRun, patchTab, resolveEditMeta, resolveTarget, showResultSet, touchActivity],
  );

  const setActiveResultIndex = useCallback(
    (tabId: string, index: number) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab?.resultSets || tab.resultSets.length === 0) return;
      showResultSet(tabId, tab.resultSets, index);
    },
    [showResultSet],
  );

  const transactionBusyRef = useRef(new Set<string>());

  const controlTransaction = useCallback(
    async (tabId: string, action: 'begin' | 'commit' | 'rollback') => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab || transactionBusyRef.current.has(tabId)) return;
      touchActivity(tab.connectionId);
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) return;
      transactionBusyRef.current.add(tabId);
      patchTab(tabId, { transactionBusy: true });
      try {
        const resolved = await resolveTarget(connection, tab.clientEncoding);
        if (resolved.ok !== true) {
          patchTab(tabId, { error: resolved.error });
          return;
        }
        const response = await controlDatabaseTransaction(resolved.target, action);
        if (response.ok !== true) {
          patchTab(tabId, {
            error: describeError(response.error),
            errorDetail: response.error,
            ...(typeof response.transactionOpen === 'boolean' ? { transactionOpen: response.transactionOpen } : {}),
          });
          return;
        }
        patchTab(tabId, {
          transactionOpen: typeof response.transactionOpen === 'boolean'
            ? response.transactionOpen
            : action === 'begin',
          error: undefined,
          errorDetail: undefined,
        });
      } catch (error) {
        patchTab(tabId, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        transactionBusyRef.current.delete(tabId);
        patchTab(tabId, { transactionBusy: false });
      }
    },
    [describeError, patchTab, resolveTarget, touchActivity],
  );

  const beginTransaction = useCallback(
    (tabId: string) => controlTransaction(tabId, 'begin'),
    [controlTransaction],
  );
  const commitTransaction = useCallback(
    (tabId: string) => controlTransaction(tabId, 'commit'),
    [controlTransaction],
  );
  const rollbackTransaction = useCallback(
    (tabId: string) => controlTransaction(tabId, 'rollback'),
    [controlTransaction],
  );

  /**
   * Switches the client charset for one tab: the pooled session is dropped so
   * the next connection is opened with the new charset, then the current
   * statement runs again so results are decoded with the new encoding.
   */
  const setEncoding = useCallback(
    async (tabId: string, encoding: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      patchTab(tabId, {
        clientEncoding: encoding,
        status: 'ready',
        result: undefined,
        resultSets: undefined,
        activeResultIndex: undefined,
        structure: undefined,
        editMeta: null,
        error: undefined,
        errorDetail: undefined,
        // The session is dropped below, and an open transaction with it.
        transactionOpen: false,
      });
      if (connection) {
        await closeDatabaseConnection(connection.id).catch(() => undefined);
      }
      const sql = tab.sql.trim();
      if (sql) await runQuery(tabId, sql, { clientEncoding: encoding });
    },
    [patchTab, runQuery],
  );

  const cancelQuery = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    if (!tab) return;
    // Invalidate the run first: whatever the statement returns now is stale,
    // and a multi-statement script must not start its next statement.
    beginRun(tabId);
    runningRef.current.delete(tabId);
    patchTab(tabId, {
      running: false,
      runStartedAt: undefined,
      executingStatement: null,
      error: tRef.current('databases.workbench.queryCancelled'),
      errorDetail: undefined,
    });
    void cancelDatabaseQuery(tab.connectionId);
  }, [beginRun, patchTab]);

  const reconnect = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) return;
      // Reconnect means a fresh session (and tunnel): the old one is the
      // reason the user is here, and its transaction is gone either way.
      beginRun(tabId);
      runningRef.current.delete(tabId);
      patchTab(tabId, {
        running: false,
        runStartedAt: undefined,
        executingStatement: null,
        transactionOpen: false,
        offline: false,
      });
      await closeDatabaseConnection(connection.id);
      if (connection.sshHostId) await closeDatabaseTunnel(connection.id);
      touchActivity(connection.id);
      await connectTab(tabId, connection);
    },
    [beginRun, connectTab, patchTab, touchActivity],
  );

  // Hydrate persisted tabs once connections are available. Restored tabs stay
  // disconnected until the user activates them.
  const hydrateGuardRef = useRef(false);
  useEffect(() => {
    if (hydrateGuardRef.current) return;
    if (connections.length === 0) return;
    hydrateGuardRef.current = true;
    const persisted = databaseTabStore.loadPersisted();
    if (!persisted || persisted.tabs.length === 0) return;
    const restored = persisted.tabs
      .map((entry) => {
        const connection = connections.find((item) => item.id === entry.connectionId);
        if (!connection) return null;
        const tab: DatabaseTab = {
          id: entry.id,
          connectionId: entry.connectionId,
          title: entry.title || connection.label,
          kind: connection.kind,
          sql: databaseTabStore.loadDraft(entry.id) ?? entry.sql ?? '',
          status: 'idle',
          connected: false,
          running: false,
          maxRows: 1000,
        };
        return tab;
      })
      .filter((tab): tab is DatabaseTab => tab !== null);
    if (restored.length === 0) return;
    setTabs((prev) => (prev.length === 0 ? restored : prev));
    const persistedActive = persisted.activeTabId;
    setActiveTabIdState((current) =>
      current ??
      (persistedActive && restored.some((tab) => tab.id === persistedActive)
        ? persistedActive
        : restored[0].id),
    );
  }, [connections]);

  // Publish tab summaries for the tab bar and persist drafts for restart restore.
  useEffect(() => {
    const summaries = tabs.map((tab) => ({
      id: tab.id,
      connectionId: tab.connectionId,
      title: tab.title,
      kind: tab.kind,
      status: (tab.connected ? 'ready' : tab.status) as 'idle' | 'connecting' | 'ready' | 'error',
      transactionOpen: tab.transactionOpen,
    }));
    databaseTabStore.sync(summaries, activeTabId);
    databaseTabStore.saveDrafts(
      tabs.map((tab) => ({
        id: tab.id,
        connectionId: tab.connectionId,
        title: tab.title,
        sql: tab.sql,
      })),
      activeTabId,
    );
  }, [tabs, activeTabId]);

  // Requests raised by the vault list / tab bar (open or close).
  const tabRequest = useDatabaseTabRequest();
  useEffect(() => {
    if (!tabRequest) return;
    databaseTabStore.clearRequest(tabRequest.nonce);
    if (tabRequest.type === 'open') {
      const connection = connectionsRef.current.find((item) => item.id === tabRequest.connectionId);
      if (!connection) return;
      void openTab(connection, { forceNew: tabRequest.forceNew }).then((id) => {
        setActiveTabIdState(id);
        databaseTabStore.activate(id);
        databaseTabStore.markActive(id);
      });
    } else if (tabRequest.type === 'close') {
      closeTab(tabRequest.tabId);
    }
  }, [tabRequest, openTab, closeTab]);

  // A restored tab connects lazily the first time it becomes active.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabsRef.current.find((entry) => entry.id === activeTabId);
    if (!tab || tab.status !== 'idle') return;
    const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
    if (!connection) return;
    void connectTab(activeTabId, connection);
  }, [activeTabId, connectTab]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  useEffect(() => () => {
    // Closing the workbench drops every pooled session and ad-hoc SSH tunnel.
    for (const tab of tabsRef.current) void closeDatabaseConnection(tab.connectionId);
    void closeAllDatabaseTunnels();
  }, []);

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    closeTab,
    setActiveTabId,
    updateSql,
    runQuery,
    setMaxRows,
    refreshTables,
    previewTable,
    showStructure,
    clearStructure,
    updateCell,
    deleteRow,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    setEncoding,
    cancelQuery,
    reconnect,
    setActiveResultIndex,
  };
}
