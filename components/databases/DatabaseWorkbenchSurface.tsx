/**
 * SQL workbench: connection tabs, a Monaco SQL editor, and a virtualized result
 * grid. All query orchestration lives in useDatabaseWorkbench.
 */

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Columns2,
  Search,
  ArrowUpDown,
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ChevronRight,
  Download,
  History,
  Loader2,
  Play,
  RotateCw,
  Rows2,
  Sparkles,
  Square,
  Table2,
  Trash2,
  Eye,
  CheckCircle2,
  FileCode2,
  Save,
  Wand2,
  X,
} from 'lucide-react';
import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { format as formatSqlText } from 'sql-formatter';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useDatabaseWorkbench, type DatabaseTab } from '../../application/state/useDatabaseWorkbench';
import { ResultSetTabs } from './ResultSetTabs';
import { databaseTabStore } from '../../application/state/databaseTabStore';
import type { DatabaseConnection, DbCellValue, DbQueryResult } from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { FixedSizeVirtualList, type FixedSizeVirtualListHandle } from '../ui/FixedSizeVirtualList';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScriptCodeEditor, type ScriptCodeEditorHandle } from '../scripts/ScriptCodeEditor';
import { beginSplitDrag, SplitHandle, useSplitRatio } from '../ui/resizable-split';
import { buildSqlCompletionEntries } from '../../domain/database/sqlCompletion';
import { applyWidths, widthScopeKey } from '../../domain/database/columnWidths';
import { useDatabaseColumnWidthStore } from '../../application/state/useDatabaseColumnWidths';
import { SqlAssistantDialog } from './SqlAssistantDialog';
import { useSqlHistory } from '../../application/state/useSqlHistory';
import type { DatabaseTunnelDeps, DbTableRef } from '../../application/state/useDatabaseWorkbench';
import {
  resultToCsv,
  resultToInsertSql,
  resultToJson,
  suggestExportFileName,
} from '../../domain/database/sqlResultExport';
import { classifySqlSafety } from '../../domain/database/sqlSafety';
import { statementAtLine } from '../../domain/database/sqlStatements';
import {
  columnsToTsv,
  findResultMatches,
  stepResultMatchCursor,
  sortResultRows,
  type ResultSort,
} from '../../domain/database/resultGrid';
import { xlsxBase64 } from '../../domain/database/xlsx';
import { copyTextWithFeedback } from '../curl/clipboard';
import { useClipboardBackend } from '../../application/state/useClipboardBackend';
import { filterTables } from '../../domain/database/tableFilter';
import {
  DATABASE_ENCODINGS,
  currentDatabaseEncoding,
} from '../../domain/database/encoding';
import { readSqlFile, saveDatabaseBinaryFile, saveSqlFile } from '@/infrastructure/services/databaseService.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from '../ui/toast';

const SQL_DIALECTS: Record<string, 'postgresql' | 'mysql' | 'mariadb' | 'plsql' | 'sqlite'> = {
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  oracle: 'plsql',
  sqlite: 'sqlite',
} as const;

const CELL_PADDING_X = 12;
const MIN_COLUMN_WIDTH = 120;
const MAX_COLUMN_WIDTH = 420;

function cellText(value: DbCellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function columnWidths(result: DbQueryResult | undefined): number[] {
  if (!result) return [];
  const sample = result.rows.slice(0, 50);
  return result.columns.map((column, index) => {
    let longest = column.name.length;
    for (const row of sample) {
      const text = cellText(row[index]);
      if (text.length > longest) longest = text.length;
    }
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, longest * 7.5 + CELL_PADDING_X * 2 + 12));
  });
}

function StatusDot({ tab }: { tab: DatabaseTab }) {
  // Same element in every state, so the color cross-fades and the "ready"
  // ping plays exactly when the class is added.
  if (tab.status === 'connecting') {
    return <span className="nc-status-dot h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />;
  }
  if (tab.status === 'error' || !tab.connected) {
    return <span className="nc-status-dot h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />;
  }
  if (tab.offline) {
    return <span className="nc-status-dot nc-status-dot--warn h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="offline" />;
  }
  return <span className="nc-status-dot nc-status-dot--ready h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />;
}

const formatElapsedSeconds = (ms: number): string =>
  ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));

/**
 * Live "running for 3.2 s" counter. Its own component so the 100 ms ticks
 * re-render only this label, not the editor and the result grid.
 */
const RunElapsed: React.FC<{ startedAt?: number; format: (seconds: string) => string }> = ({
  startedAt,
  format,
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  return (
    <span className="nc-anim-fade-in whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
      {format(formatElapsedSeconds(Math.max(0, now - startedAt)))}
    </span>
  );
};

interface DatabaseWorkbenchSurfaceProps {
  /** Workbench tab id (without the `database:` prefix), or null when idle. */
  tabId: string | null;
  connections: DatabaseConnection[];
  /** Vault lookups used to dial connections that route through an SSH host. */
  tunnelDeps?: DatabaseTunnelDeps;
  onUpdateConnections?: (connections: DatabaseConnection[] | ((prev: DatabaseConnection[]) => DatabaseConnection[])) => void;
}

interface DatabaseTabPaneProps {
  tab: DatabaseTab;
  workbench: ReturnType<typeof useDatabaseWorkbench>;
  connections: readonly DatabaseConnection[];
  onUpdateConnections?: (connections: DatabaseConnection[] | ((prev: DatabaseConnection[]) => DatabaseConnection[])) => void;
  sqlHistory: ReturnType<typeof useSqlHistory>;
  schemaWidth: number;
  onSchemaResizeStart: (event: React.MouseEvent) => void;
  autoFocus?: boolean;
  headerActions?: React.ReactNode;
}

/**
 * One editor pane: toolbar, schema tree, SQL editor, result grid and status bar.
 * Tab state is owned by the surface so split panes can share it.
 */
const DatabaseTabPane: React.FC<DatabaseTabPaneProps> = ({
  tab,
  workbench,
  connections,
  onUpdateConnections,
  sqlHistory,
  schemaWidth,
  onSchemaResizeStart,
  autoFocus,
  headerActions,
}) => {
  const { t } = useI18n();
  const columnWidthStore = useDatabaseColumnWidthStore();
  const editorRef = useRef<ScriptCodeEditorHandle | null>(null);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [editorRatio, setEditorRatio] = useSplitRatio('netcatty.db.splitRatio', 0.38);
  const connection = useMemo(
    () => connections.find((entry) => entry.id === tab.connectionId),
    [connections, tab.connectionId],
  );
  const [pendingRun, setPendingRun] = useState<{ sql: string; reasons: string[] } | null>(null);
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryName, setSaveQueryName] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<ResultSort | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedColumns, setSelectedColumns] = useState<number[]>([]);
  const [matchCursor, setMatchCursor] = useState(0);
  const [highlight, setHighlight] = useState<{ sourceIndex: number; columnIndex: number } | null>(null);
  const { writeClipboardText } = useClipboardBackend();

  // Search / sort / selection are per tab: switching tabs starts clean so a
  // filter in one database cannot leak into every other tab.
  useEffect(() => {
    setSearchQuery('');
    setSelectedColumns([]);
    setMatchCursor(0);
    setHighlight(null);
  }, [tab.id]);

  const executeSql = useCallback(
    (sqlOverride: string | undefined) => {
      sqlHistory.record(tab.connectionId, sqlOverride ?? tab.sql);
      void workbench.runQuery(tab.id, sqlOverride);
    },
    [sqlHistory, tab, workbench],
  );

  const runActiveQuery = useCallback(() => {
    const editor = editorRef.current;
    const selection = editor?.getSelectionText()?.trim();
    const hasSelection = Boolean(selection && selection.length > 0);
    // With a selection, run exactly that (it may hold several statements);
    // otherwise run the statement under the caret instead of the whole script.
    const statement = hasSelection
      ? selection!
      : statementAtLine(editor?.getValue() || tab.sql, editor?.getCursorLine() ?? 1) ||
        (editor?.getCursorLineText() ?? '').trim();
    const sql = (statement || tab.sql).trim();
    if (!sql) return;
    const safety = classifySqlSafety(sql);
    if (connection?.readOnly && safety.risk !== 'read') {
      toast.error(t('databases.workbench.readOnlyBlocked'));
      return;
    }
    if (safety.risk === 'destructive') {
      setPendingRun({ sql, reasons: safety.reasons });
      return;
    }
    if (hasSelection) {
      executeSql(sql);
      return;
    }
    // Running just the caret statement must not replace the editor content, so
    // pass it as the override rather than the whole document.
    sqlHistory.record(tab.connectionId, sql);
    void workbench.runQuery(tab.id, sql);
  }, [connection?.readOnly, tab.connectionId, tab.id, tab.sql, executeSql, sqlHistory, t, workbench]);

  const downloadResult = useCallback(
    async (format: 'csv' | 'json' | 'sql' | 'xlsx') => {
      const result = tab.result;
      if (!result) return;
      const dialect = SQL_DIALECTS[tab.kind] ?? 'postgresql';
      const tableMatch = /\bfrom\s+([\w."`]+)/i.exec(tab.sql);
      const tableName = tableMatch ? tableMatch[1].replace(/["`]/g, '') : 'result';

      if (format === 'xlsx') {
        const fileName = suggestExportFileName(tab.title || tableName, 'xlsx', Date.now());
        const saved = await saveDatabaseBinaryFile(
          fileName,
          xlsxBase64({ name: tableName || 'Result', columns: result.columns, rows: result.rows }),
        );
        if (saved.ok === false) {
          toast.error(t('databases.workbench.exportFailed', { error: saved.error }));
          return;
        }
        if (!saved.canceled) toast.success(t('databases.workbench.exportSaved'));
        return;
      }

      const payload =
        format === 'csv'
          ? resultToCsv(result)
          : format === 'json'
            ? resultToJson(result)
            : resultToInsertSql(result, tableName, dialect);
      if (!payload) return;
      const mime = format === 'csv' ? 'text/csv' : format === 'json' ? 'application/json' : 'application/sql';
      const prefix = format === 'csv' ? '\ufeff' : '';
      const blob = new Blob([`${prefix}${payload}`], { type: `${mime};charset=utf-8;` });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = suggestExportFileName(tab.title, format === 'sql' ? 'sql' : format, Date.now());
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [t, tab],
  );

  const openSqlFile = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.selectFile) return;
    const filePath = await bridge.selectFile(t('databases.workbench.openSqlFileTitle'), undefined, [
      { name: 'SQL', extensions: ['sql', 'txt'] },
    ]);
    if (!filePath) return;
    const loaded = await readSqlFile(filePath);
    if (!loaded.ok) {
      toast.error(t('databases.workbench.openSqlFileFailed', { error: (loaded as { error?: string }).error ?? 'read-failed' }));
      return;
    }
    workbench.updateSql(tab.id, loaded.text);
    workbench.bindSqlFile(tab.id, filePath, loaded.text);
    sqlHistory.record(tab.connectionId, loaded.text);
    toast.success(t('databases.workbench.openSqlFileLoaded'));
  }, [tab, sqlHistory, t, workbench]);

  // Save writes back to the bound file; the first save (and "save as") asks
  // where to put it. The main process only overwrites files picked in a dialog.
  const saveSqlToFile = useCallback(
    async (saveAs = false) => {
      const content = tab.sql;
      const saved = await saveSqlFile({
        content,
        ...(tab.filePath && !saveAs ? { path: tab.filePath } : {}),
        defaultName: tab.filePath ? sqlFileName(tab.filePath) : `${sanitizeSqlFileName(tab.title)}.sql`,
      });
      if (!saved.ok) {
        toast.error(t('databases.workbench.saveSqlFileFailed', { error: (saved as { error?: string }).error ?? 'write-failed' }));
        return;
      }
      if (saved.canceled || !saved.path) return;
      workbench.bindSqlFile(tab.id, saved.path, content);
      toast.success(t('databases.workbench.saveSqlFileSaved', { name: sqlFileName(saved.path) }));
    },
    [t, tab.filePath, tab.id, tab.sql, tab.title, workbench],
  );
  const sqlFileDirty = Boolean(tab.filePath) && tab.fileSavedSql !== tab.sql;

  const saveCurrentQuery = useCallback(() => {
    if (!onUpdateConnections) return;
    const name = saveQueryName.trim();
    const sql = editorRef.current?.getSelectionText()?.trim() || tab.sql.trim();
    if (!name || !sql) return;
    const connectionId = tab.connectionId;
    const query = { id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, sql, createdAt: Date.now() };
    onUpdateConnections((prev) =>
      prev.map((entry) =>
        entry.id === connectionId
          ? { ...entry, savedQueries: [...(entry.savedQueries ?? []), query] }
          : entry,
      ),
    );
    setSaveQueryOpen(false);
    setSaveQueryName('');
    toast.success(t('databases.workbench.saveQuerySaved'));
  }, [tab, onUpdateConnections, saveQueryName, t]);

  const loadSavedQuery = useCallback(
    (sql: string) => {
      workbench.updateSql(tab.id, sql);
    },
    [tab.id, workbench],
  );

  const deleteSavedQuery = useCallback(
    (queryId: string) => {
      if (!onUpdateConnections) return;
      const connectionId = tab.connectionId;
      onUpdateConnections((prev) =>
        prev.map((entry) =>
          entry.id === connectionId
            ? { ...entry, savedQueries: (entry.savedQueries ?? []).filter((q) => q.id !== queryId) }
            : entry,
        ),
      );
    },
    [tab.connectionId, onUpdateConnections],
  );

  const activeHistory = sqlHistory.entriesFor(tab.connectionId);

  const autoWidths = useMemo(() => columnWidths(tab.result), [tab.result]);
  const widthScope = useMemo(
    () =>
      tab.result
        ? widthScopeKey(tab.connectionId, tab.editMeta?.target.table, tab.result.columns.map((column) => column.name))
        : '',
    [tab.connectionId, tab.editMeta, tab.result],
  );
  const savedWidths = columnWidthStore.widthsFor(widthScope);
  const widths = useMemo(
    () => applyWidths(autoWidths, tab.result?.columns ?? [], savedWidths),
    [autoWidths, savedWidths, tab.result],
  );

  // Built once per schema / structure / result change, not per keystroke: the
  // editor asks for completions on every typed character, and sorting a few
  // thousand table names each time made typing lag on large databases.
  const structureColumns = tab.structure?.columns;
  const resultColumns = tab.result?.columns;
  const sqlCompletionEntries = useMemo(
    () =>
      buildSqlCompletionEntries({
        tables: tab.tables,
        columns: structureColumns ?? [],
        resultColumns: resultColumns ?? [],
      }),
    [tab.tables, structureColumns, resultColumns],
  );
  const sqlCompletionSource = useCallback(() => sqlCompletionEntries, [sqlCompletionEntries]);
  // Stable callbacks so the memoized schema panel is not re-rendered by typing.
  const tabId = tab.id;
  const { refreshTables, previewTable, showStructure } = workbench;
  const refreshSchema = useCallback(() => void refreshTables(tabId), [tabId, refreshTables]);
  const previewSchemaTable = useCallback(
    (table: DbTableRef) => void previewTable(tabId, table),
    [tabId, previewTable],
  );
  const showSchemaStructure = useCallback(
    (table: DbTableRef) => void showStructure(tabId, table),
    [tabId, showStructure],
  );

  const pageSize = tab.maxRows || 1000;
  const allRows = useMemo(() => tab.result?.rows ?? [], [tab.result]);
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
  const pageIndex = Math.min(Math.max(0, page), totalPages - 1);

  // Sorting and search run over the whole fetched result, which is what makes
  // both work across page boundaries.
  const orderedSourceIndexes = useMemo(
    () => sortResultRows(allRows, sort),
    [allRows, sort],
  );
  const orderedRows = useMemo(
    () => orderedSourceIndexes.map((sourceIndex) => ({ cells: allRows[sourceIndex] ?? [], sourceIndex })),
    [allRows, orderedSourceIndexes],
  );
  const pagedRows = useMemo(
    () => orderedRows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [orderedRows, pageIndex, pageSize],
  );
  // Display position of each source row, so match jumps land on the right page
  // even while a sort reorders the grid.
  const positionBySource = useMemo(() => {
    const positions = new Map<number, number>();
    orderedSourceIndexes.forEach((sourceIndex, position) => positions.set(sourceIndex, position));
    return positions;
  }, [orderedSourceIndexes]);
  // Matches in the order they appear on screen, so previous / next walk the
  // grid top to bottom whatever the sort is.
  const matches = useMemo(() => {
    const found = findResultMatches(allRows, selectedColumns, searchQuery);
    const position = (rowIndex: number) => positionBySource.get(rowIndex) ?? rowIndex;
    return found.sort(
      (left, right) => position(left.rowIndex) - position(right.rowIndex) || left.columnIndex - right.columnIndex,
    );
  }, [allRows, positionBySource, selectedColumns, searchQuery]);
  const matchPositions = useMemo(
    () => matches.map((match) => positionBySource.get(match.rowIndex) ?? match.rowIndex),
    [matches, positionBySource],
  );
  const activeMatch = matches.length > 0 ? matches[Math.min(matchCursor, matches.length - 1)] : null;
  // Bumped by every previous / next click: revealing must happen even when the
  // cursor value does not change (single match, or paging back to it).
  const [revealToken, setRevealToken] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [tab.id, tab.result]);

  // Sorting changes row order, so go back to the first page.
  useEffect(() => {
    setPage(0);
  }, [sort]);

  // Keep the cursor inside the match list when the query or scope changes.
  useEffect(() => {
    setMatchCursor(0);
  }, [searchQuery, selectedColumns]);

  // Follow the active match: switch to its page and highlight the cell.
  useEffect(() => {
    if (!activeMatch) {
      setHighlight(null);
      return;
    }
    setHighlight({ sourceIndex: activeMatch.rowIndex, columnIndex: activeMatch.columnIndex });
    const position = positionBySource.get(activeMatch.rowIndex) ?? activeMatch.rowIndex;
    setPage(Math.floor(position / pageSize));
  }, [activeMatch, pageSize, positionBySource, revealToken]);

  const toggleSort = useCallback((columnIndex: number) => {
    setSort((current) => {
      if (!current || current.columnIndex !== columnIndex) return { columnIndex, direction: 'asc' };
      if (current.direction === 'asc') return { columnIndex, direction: 'desc' };
      return null;
    });
  }, []);

  const toggleColumn = useCallback((columnIndex: number, additive: boolean) => {
    setSelectedColumns((current) => {
      if (!additive) return current.length === 1 && current[0] === columnIndex ? [] : [columnIndex];
      return current.includes(columnIndex)
        ? current.filter((entry) => entry !== columnIndex)
        : [...current, columnIndex];
    });
  }, []);

  /** Copy the given columns (all columns when the list is empty) as TSV. */
  const copyColumns = useCallback((columnIndexes: number[]) => {
    if (!tab.result) return;
    const columns = tab.result.columns;
    const targets = columnIndexes.length > 0 ? columnIndexes : columns.map((_, index) => index);
    // Copy in the order the grid shows: sorted when a sort is active.
    const rows = sort ? orderedSourceIndexes.map((index) => allRows[index] ?? []) : allRows;
    const text = columnsToTsv(columns, [...rows], targets);
    if (!text) return;
    void copyTextWithFeedback(
      writeClipboardText,
      text,
      t('databases.workbench.copiedRows', { count: String(rows.length) }),
      t('curl.copyFailed'),
    );
  }, [allRows, orderedSourceIndexes, sort, t, tab.result, writeClipboardText]);

  /** Copy a single row as TSV across every column. */
  const copyRow = useCallback((sourceIndex: number) => {
    if (!tab.result) return;
    const row = allRows[sourceIndex];
    if (!row) return;
    const text = columnsToTsv(tab.result.columns, [row], []);
    if (!text) return;
    void copyTextWithFeedback(
      writeClipboardText,
      text,
      t('databases.workbench.copiedRow'),
      t('curl.copyFailed'),
    );
  }, [allRows, t, tab.result, writeClipboardText]);

  const copyCell = useCallback(
    (text: string) => {
      void copyTextWithFeedback(writeClipboardText, text, t('databases.workbench.cellCopied'), t('curl.copyFailed'));
    },
    [t, writeClipboardText],
  );

  const goToMatch = useCallback(
    (delta: number) => {
      if (matches.length === 0) return;
      const direction = delta < 0 ? -1 : 1;
      const current = Math.min(matchCursor, matches.length - 1);
      const start = pageIndex * pageSize;
      const activePosition = matchPositions[current] ?? -1;
      // Paged away from the active match by hand: continue from this page.
      const awayFromActive = activePosition < start || activePosition >= start + pageSize;
      setMatchCursor(
        stepResultMatchCursor(
          matchPositions,
          current,
          direction,
          awayFromActive ? { start, end: start + pageSize } : null,
        ),
      );
      setRevealToken((token) => token + 1);
    },
    [matchCursor, matchPositions, matches.length, pageIndex, pageSize],
  );

  const [aiOpen, setAiOpen] = useState(false);
  const schemaText = useMemo(
    () => (tab.tables ?? []).slice(0, 80).map((table) => table.name).join(', '),
    [tab.tables],
  );

  // Mirror the statement being executed into the editor as a line highlight.
  useEffect(() => {
    const executing = tab.executingStatement ?? null;
    if (!executing) {
      editorRef.current?.highlightLines(null);
      return;
    }
    editorRef.current?.highlightLines(executing.startLine, executing.endLine);
  }, [tab.executingStatement]);

  const formatSql = () => {
    const dialect = SQL_DIALECTS[tab.kind] ?? 'postgresql';
    try {
      const formatted = formatSqlText(tab.sql, { language: dialect as never });
      if (formatted && formatted !== tab.sql) workbench.updateSql(tab.id, formatted);
    } catch {
      // Formatting is best-effort; leave the statement untouched on parse errors.
    }
  };

  const changeEncoding = async (value: string) => {
    if (!connection) return;
    onUpdateConnections?.((prev) =>
      prev.map((entry) => (entry.id === connection.id ? { ...entry, clientEncoding: value } : entry)),
    );
    await workbench.setEncoding(tab.id, value);
  };

  return (
    <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
      <StatusDot tab={tab} />
      <span className="truncate font-medium">{tab.title}</span>
      {tab.transactionOpen ? (
        <span className="nc-anim-pop-in rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          {t('databases.workbench.transactionActive')}
        </span>
      ) : null}
      {tab.executingStatement ? (
        <span className="nc-anim-fade-in rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">
          {t('databases.workbench.statementProgress', {
            index: tab.executingStatement.index,
            total: tab.executingStatement.total,
          })}
        </span>
      ) : null}
      {currentDatabaseEncoding(tab.kind, tab.clientEncoding ?? connection?.clientEncoding) ? (
        <Select
          value={currentDatabaseEncoding(tab.kind, tab.clientEncoding ?? connection?.clientEncoding) ?? ''}
          onValueChange={(value) => void changeEncoding(value)}
        >
          <SelectTrigger
            className="ml-auto h-6 w-[116px] text-[11px]"
            aria-label={t('databases.workbench.encoding')}
            title={t('databases.workbench.encodingHint')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATABASE_ENCODINGS.map((encoding) => (
              <SelectItem key={encoding} value={encoding} className="text-xs">
                {encoding}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <span className={cn('truncate font-mono text-[11px] text-muted-foreground', currentDatabaseEncoding(tab.kind, tab.clientEncoding ?? connection?.clientEncoding) ? '' : 'ml-auto')}>
        {tab.serverVersion ?? ''}
      </span>
    </div>
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <Button
        size="sm"
        className="h-7 text-xs"
        disabled={tab.running || !tab.connected || !tab.sql.trim()}
        onClick={runActiveQuery}
      >
        {tab.running ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Play className="mr-1 h-3 w-3" />
        )}
        {tab.running ? t('databases.workbench.running') : t('databases.workbench.run')}
      </Button>
      {tab.running ? (
        <Button
          size="sm"
          variant="outline"
          className="nc-anim-pop-in h-7 text-xs"
          onClick={() => workbench.cancelQuery(tab.id)}
        >
          <Square className="mr-1 h-3 w-3" />
          {t('databases.workbench.cancel')}
        </Button>
      ) : null}
      <RunElapsed
        startedAt={tab.running ? tab.runStartedAt : undefined}
        format={(seconds) => t('databases.workbench.runningElapsed', { seconds })}
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
            <Bookmark className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
          {(connection?.savedQueries ?? []).length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t('databases.workbench.savedQueriesEmpty')}
            </p>
          ) : (
            <div className="max-h-64 overflow-auto">
              {(connection?.savedQueries ?? []).map((query) => (
                <div key={query.id} className="group flex items-center gap-1 rounded px-1">
                  <button
                    type="button"
                    className="flex-1 truncate px-1 py-1 text-left text-xs hover:text-foreground"
                    title={query.sql}
                    onClick={() => loadSavedQuery(query.sql)}
                  >
                    {query.name}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                    onClick={() => deleteSavedQuery(query.id)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={!tab || !onUpdateConnections}
            onClick={() => {
              setSaveQueryName('');
              setSaveQueryOpen(true);
            }}
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.saveQuery')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => void openSqlFile()}
          >
            <FileCode2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.openSqlFile')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="relative h-7 w-7 p-0"
            data-testid="db-save-sql-file"
            aria-label={t('databases.workbench.saveSqlFile')}
            onClick={(event) => void saveSqlToFile(event.shiftKey)}
          >
            <Save className="h-3.5 w-3.5" />
            {sqlFileDirty ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.saveSqlFile')}</TooltipContent>
      </Tooltip>
      {tab.filePath ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex h-7 max-w-[180px] items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void saveSqlToFile(true)}
            >
              <span className="truncate font-mono">{sqlFileName(tab.filePath)}</span>
              {sqlFileDirty ? <span className="shrink-0 text-amber-500" aria-label={t('databases.workbench.sqlFileUnsaved')}>●</span> : null}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="block max-w-[420px] break-all font-mono text-[11px]">{tab.filePath}</span>
            <span className="block text-[11px] opacity-80">{t('databases.workbench.saveSqlFileAs')}</span>
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={formatSql}>
            <Wand2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.format')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setAiOpen(true)}>
            <Sparkles className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.ai.title')}</TooltipContent>
      </Tooltip>
      {tab.transactionOpen ? (
        <>
          <Button
            size="sm"
            variant="outline"
            className="nc-anim-pop-in h-7 text-xs"
            disabled={tab.running || tab.transactionBusy}
            onClick={() => void workbench.commitTransaction(tab.id)}
          >
            {tab.transactionBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {t('databases.workbench.commit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="nc-anim-pop-in h-7 text-xs"
            disabled={tab.running || tab.transactionBusy}
            onClick={() => void workbench.rollbackTransaction(tab.id)}
          >
            {t('databases.workbench.rollback')}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={tab.running || !tab.connected || tab.transactionBusy}
          onClick={() => void workbench.beginTransaction(tab.id)}
        >
          {tab.transactionBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {t('databases.workbench.beginTransaction')}
        </Button>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={activeHistory.length === 0}
            aria-label={t('databases.workbench.history')}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[420px] p-1">
          <div className="max-h-[320px] overflow-y-auto">
            {activeHistory.slice(0, 20).map((entry) => (
              <button
                key={`${entry.at}-${entry.sql.slice(0, 40)}`}
                type="button"
                className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-[11px] hover:bg-secondary"
                title={entry.sql}
                onClick={() => {
                  workbench.updateSql(tab.id, entry.sql);
                }}
              >
                {entry.sql.replace(/\s+/g, ' ')}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={!tab.result}
            title={t('databases.workbench.exportCsv')}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-40 p-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground px-2 py-1">
            {t('databases.workbench.exportTitle')}
          </div>
          {(['csv', 'json', 'sql', 'xlsx'] as const).map((format) => (
            <button
              key={format}
              type="button"
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-secondary"
              onClick={() => downloadResult(format)}
            >
              {t(`databases.workbench.export.${format}`)}
            </button>
          ))}
        </PopoverContent>
      </Popover>
      {tab.status === 'error' || tab.offline ? (
        <Button
          size="sm"
          variant={tab.offline && tab.status !== 'error' ? 'default' : 'outline'}
          className="nc-anim-pop-in h-7 text-xs"
          disabled={tab.status === 'connecting'}
          onClick={() => void workbench.reconnect(tab.id)}
        >
          <RotateCw className="mr-1 h-3 w-3" />
          {tab.offline && tab.status !== 'error'
            ? t('databases.workbench.connectionLost')
            : t('databases.workbench.reconnect')}
        </Button>
      ) : null}
      {headerActions ? <div className="ml-auto flex items-center gap-1">{headerActions}</div> : null}
    </div>

    <div className="flex min-h-0 min-w-0 flex-1">
      <SchemaPanel
        tabId={tab.id}
        tables={tab.tables}
        loading={Boolean(tab.tablesLoading)}
        error={tab.tablesError}
        width={schemaWidth}
        onRefresh={refreshSchema}
        onPreview={previewSchemaTable}
        onShowStructure={showSchemaStructure}
        t={t}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('databases.schema.resize')}
        className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border"
        onMouseDown={onSchemaResizeStart}
      />
      <div ref={splitContainerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div
      className="flex min-h-0 min-w-0 flex-col"
      style={{ flexBasis: `${editorRatio * 100}%`, flexGrow: 0, flexShrink: 0 }}
      // Capture phase: the editor swallows key events it does not know.
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopPropagation();
          void saveSqlToFile(event.shiftKey);
        }
      }}
    >
      <ScriptCodeEditor
        value={tab.sql}
        onChange={(value) => workbench.updateSql(tab.id, value)}
        language="sql"
        fill
        active
        autoFocus={autoFocus}
        ariaLabel={t('databases.workbench.editorLabel')}
        placeholder={t('databases.workbench.placeholder')}
        ref={editorRef}
        onSubmitShortcut={runActiveQuery}
        sqlCompletion={sqlCompletionSource}
      />
    </div>

    <SplitHandle
      label={t('databases.workbench.splitResize')}
      testId="db-split-handle"
      ratio={editorRatio}
      onPointerDown={(event) => beginSplitDrag(event, splitContainerRef.current, setEditorRatio)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setEditorRatio(editorRatio - 0.02);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setEditorRatio(editorRatio + 0.02);
        } else if (event.key === 'Home') {
          event.preventDefault();
          setEditorRatio(0.38);
        }
      }}
      onDoubleClick={() => setEditorRatio(0.38)}
    />

    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tab.running ? (
        <div
          className="nc-progress-track shrink-0"
          role="progressbar"
          aria-busy="true"
          aria-label={t('databases.workbench.running')}
        />
      ) : null}
      {tab.error ? (
        <div
          key={tab.error}
          role="alert"
          className="nc-anim-slide-down shrink-0 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 space-y-0.5">
              <p className="whitespace-pre-wrap break-words font-medium">{tab.error}</p>
              {tab.errorDetail?.detail ? (
                <p className="opacity-80">{tab.errorDetail.detail}</p>
              ) : null}
              {tab.errorDetail?.hint ? (
                <p className="opacity-80">{tab.errorDetail.hint}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab.resultSets && tab.resultSets.length > 1 ? (
        <ResultSetTabs
          resultSets={tab.resultSets}
          activeIndex={tab.activeResultIndex ?? 0}
          onSelect={(index) => workbench.setActiveResultIndex(tab.id, index)}
        />
      ) : null}

      {tab.structure ? (
        <StructurePanel
          structure={tab.structure}
          onClose={() => workbench.clearStructure(tab.id)}
          onPreview={() => {
            const table = tab.structure?.table;
            if (table) void workbench.previewTable(tab.id, table);
          }}
          t={t}
        />
      ) : tab.result && tab.result.columns.length > 0 ? (
        // Keyed per run (not per edit): a new result fades in, an in-place
        // cell edit keeps the grid and its scroll position.
        <div
          key={`${tab.durationMs ?? ''}:${tab.activeResultIndex ?? 0}`}
          className="nc-anim-fade-in nc-stale-content flex min-h-0 min-w-0 flex-1 flex-col"
          data-stale={tab.running ? 'true' : undefined}
        >
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px]">
            <div className="flex min-w-0 items-center gap-1 rounded border border-border/60 px-1.5">
              <Search className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                className="h-5 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/70"
                style={{ width: 180 }}
                value={searchQuery}
                placeholder={
                  selectedColumns.length > 0
                    ? t('databases.workbench.searchSelectedHint', { count: String(selectedColumns.length) })
                    : t('databases.workbench.searchPlaceholder')
                }
                aria-label={t('databases.workbench.searchPlaceholder')}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    goToMatch(event.shiftKey ? -1 : 1);
                  } else if (event.key === 'Escape') {
                    setSearchQuery('');
                  }
                }}
              />
              {searchQuery ? (
                <button
                  type="button"
                  aria-label={t('databases.searchClear')}
                  title={t('databases.searchClear')}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setSearchQuery('');
                    setMatchCursor(0);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
              {searchQuery.trim() ? (
                <>
                  <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {matches.length > 0
                      ? t('databases.workbench.searchPosition', {
                          index: String(Math.min(matchCursor + 1, matches.length)),
                          total: String(matches.length),
                        })
                      : t('databases.workbench.searchNoMatch')}
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                    aria-label={t('databases.workbench.searchPrevious')}
                    disabled={matches.length === 0}
                    onClick={() => goToMatch(-1)}
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                    aria-label={t('databases.workbench.searchNext')}
                    disabled={matches.length === 0}
                    onClick={() => goToMatch(1)}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </>
              ) : null}
            </div>
            {selectedColumns.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => setSelectedColumns([])}
              >
                {t('databases.workbench.clearColumnSelection')}
              </Button>
            ) : null}
            {sort ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => setSort(null)}
              >
                {sort.direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                {t('databases.workbench.clearSort')}
              </Button>
            ) : null}
          </div>
          <ResultGrid
            columns={tab.result.columns}
            rows={pagedRows}
            columnWidths={widths}
            onResizeColumn={(index, width) => {
              const column = tab.result?.columns[index];
              if (!column || !widthScope) return;
              columnWidthStore.setWidth(widthScope, column.name, width);
            }}
            t={t}
            editable={Boolean(tab.editMeta) && !connection?.readOnly}
            onUpdateCell={(rowIndex, column, value) =>
              workbench.updateCell(tab.id, rowIndex, column, value)
            }
            onDeleteRow={(rowIndex) => workbench.deleteRow(tab.id, rowIndex)}
            sort={sort}
            onToggleSort={toggleSort}
            selectedColumns={selectedColumns}
            onSelectColumn={toggleColumn}
            highlight={highlight}
            onCopyCell={copyCell}
            onCopyColumns={copyColumns}
            onCopyRow={copyRow}
            onClearSelection={() => setSelectedColumns([])}
            rowNumberStart={pageIndex * pageSize}
          />
        </div>
      ) : (
        <div
          key={tab.status === 'connecting' ? 'connecting' : tab.running ? 'running' : 'empty'}
          className="nc-anim-fade-in flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          {tab.status === 'connecting' || tab.running ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary/80" />
          ) : (
            <ArrowUpDown className="h-5 w-5 text-muted-foreground/60" />
          )}
          <p className="max-w-md text-xs text-muted-foreground">
            {tab.status === 'connecting'
              ? t('databases.workbench.connecting')
              : tab.running
                ? t('databases.workbench.running')
                : t('databases.workbench.emptyHint')}
          </p>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-4 border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground">
        {tab.result && tab.result.columns.length > 0 && tab.result.rows.length > 0 && tab.editMeta ? (
          <span className="truncate">{t('databases.workbench.editHint')}</span>
        ) : null}
        <label className="flex items-center gap-1">
          <span>{t('databases.workbench.rowLimit')}</span>
          <RowLimitControl
            value={tab.maxRows}
            label={t('databases.workbench.rowLimit')}
            onChange={(value) => workbench.setMaxRows(tab.id, value)}
          />
        </label>
        <label className="flex items-center gap-1">
          <span>{t('databases.workbench.timeout')}</span>
          <select
            className="h-5 rounded border border-border/60 bg-transparent px-1 text-[11px] outline-none focus:bg-muted/40"
            value={tab.timeoutSec ?? QUERY_TIMEOUT_PRESETS[0]}
            aria-label={t('databases.workbench.timeout')}
            data-db-query-timeout=""
            onChange={(event) => workbench.setQueryTimeout(tab.id, Number(event.target.value))}
          >
            {QUERY_TIMEOUT_PRESETS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds < 60
                  ? t('databases.workbench.timeout.seconds', { count: seconds })
                  : t('databases.workbench.timeout.minutes', { count: seconds / 60 })}
              </option>
            ))}
          </select>
        </label>
        <span>
          {t('databases.workbench.rowCount', {
            count: String(tab.result?.rowCount ?? 0),
          })}
        </span>
        {allRows.length > 0 ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              disabled={pageIndex <= 0}
              aria-label={t('databases.workbench.previousPage')}
              onClick={() => setPage(pageIndex - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="whitespace-nowrap">
              {t('databases.workbench.pageOf', {
                page: String(pageIndex + 1),
                pages: String(totalPages),
              })}
            </span>
            <Input
              className="h-6 w-12 px-1 text-center text-[11px]"
              inputMode="numeric"
              value={String(pageIndex + 1)}
              aria-label={t('databases.workbench.pageNumber')}
              onChange={(event) => {
                const next = Number(event.target.value.replace(/[^0-9]/g, ''));
                if (Number.isFinite(next) && next >= 1) setPage(next - 1);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              disabled={pageIndex >= totalPages - 1}
              aria-label={t('databases.workbench.nextPage')}
              onClick={() => setPage(pageIndex + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        {tab.result?.truncated ? (
          <span className="text-amber-600 dark:text-amber-400">
            {t('databases.workbench.truncated')}
          </span>
        ) : null}
        {tab.result?.command ? <span className="font-mono">{tab.result.command}</span> : null}
        {typeof tab.durationMs === 'number' ? (
          <span className="ml-auto tabular-nums">
            {t('databases.workbench.elapsed', { ms: String(tab.durationMs) })}
          </span>
        ) : null}
      </div>
    </div>
      </div>
    </div>
      <Dialog open={saveQueryOpen} onOpenChange={setSaveQueryOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('databases.workbench.saveQueryTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={saveQueryName}
            placeholder={t('databases.workbench.saveQueryPlaceholder')}
            onChange={(event) => setSaveQueryName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveCurrentQuery();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveQueryOpen(false)}>
              {t('databases.form.cancel')}
            </Button>
            <Button disabled={!saveQueryName.trim()} onClick={saveCurrentQuery}>
              {t('databases.form.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingRun !== null}
        title={t('databases.workbench.confirmDangerTitle')}
        message={t('databases.workbench.confirmDangerMessage')}
        confirmLabel={t('databases.workbench.confirmDangerRun')}
        destructive
        onOpenChange={(next) => {
          if (!next) setPendingRun(null);
        }}
        onConfirm={() => {
          if (!pendingRun) return;
          executeSql(pendingRun.sql);
          setPendingRun(null);
        }}
      />
      <SqlAssistantDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        currentSql={editorRef.current?.getSelectionText() || tab.sql}
        schemaText={schemaText}
        dialect={tab.kind}
        onApply={(sql) => workbench.updateSql(tab.id, sql)}
      />
    </>
  );
};

export const DatabaseWorkbenchSurface: React.FC<DatabaseWorkbenchSurfaceProps> = ({
  tabId,
  connections,
  onUpdateConnections,
  tunnelDeps,
}) => {
  const { t } = useI18n();
  const workbench = useDatabaseWorkbench(connections, tunnelDeps);
  const { tabs, activeTab } = workbench;
  const sqlHistory = useSqlHistory();

  useEffect(() => {
    if (!tabId) return;
    workbench.setActiveTabId(tabId);
    databaseTabStore.markActive(tabId);
  }, [tabId, workbench]);

  const [schemaWidth, setSchemaWidth] = useState(190);
  const beginSchemaResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = schemaWidth;
      const onMove = (move: MouseEvent) => {
        setSchemaWidth(Math.min(560, Math.max(140, startWidth + (move.clientX - startX))));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [schemaWidth],
  );

  const [secondaryTabId, setSecondaryTabId] = useState<string | null>(null);
  const [splitDirection, setSplitDirection] = useState<'horizontal' | 'vertical'>('horizontal');
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  const secondaryTab = secondaryTabId ? tabs.find((tab) => tab.id === secondaryTabId) : undefined;

  useEffect(() => {
    if (secondaryTabId && !tabs.some((tab) => tab.id === secondaryTabId)) setSecondaryTabId(null);
  }, [tabs, secondaryTabId]);

  const openSecondaryPane = useCallback(
    async (direction: 'horizontal' | 'vertical') => {
      const active = workbench.activeTab;
      if (!active) return;
      setSplitDirection(direction);
      const other = tabs.find((tab) => tab.id !== active.id);
      if (other) {
        setSecondaryTabId(other.id);
        return;
      }
      const connection = connections.find((entry) => entry.id === active.connectionId);
      if (!connection) return;
      const newTabId = await workbench.openTab(connection, { forceNew: true });
      workbench.setActiveTabId(active.id);
      setSecondaryTabId(newTabId || null);
    },
    [connections, tabs, workbench],
  );

  const beginSplitResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const onMove = (move: MouseEvent) => {
        const next =
          splitDirection === 'vertical'
            ? (move.clientY - rect.top) / Math.max(1, rect.height)
            : (move.clientX - rect.left) / Math.max(1, rect.width);
        setSplitRatio(Math.min(0.8, Math.max(0.2, next)));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [splitDirection],
  );

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t('databases.workbench.noTab')}
      </div>
    );
  }

  const splitControls = (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            aria-label={t('databases.workbench.splitRight')}
            onClick={() => void openSecondaryPane('horizontal')}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.splitRight')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            aria-label={t('databases.workbench.splitDown')}
            onClick={() => void openSecondaryPane('vertical')}
          >
            <Rows2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.splitDown')}</TooltipContent>
      </Tooltip>
      {secondaryTab ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              aria-label={t('databases.workbench.closeSplit')}
              onClick={() => setSecondaryTabId(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('databases.workbench.closeSplit')}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );

  const secondaryControls = (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" className="h-6 max-w-[220px] gap-1 px-1.5 text-[11px]">
            <Table2 className="h-3 w-3 shrink-0" />
            <span className="truncate">{secondaryTab?.title ?? ''}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-1">
          <div className="max-h-64 overflow-y-auto">
            {tabs
              .filter((tab) => tab.id !== activeTab.id)
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-secondary',
                    tab.id === secondaryTab?.id ? 'bg-secondary/60' : '',
                  )}
                  onClick={() => setSecondaryTabId(tab.id)}
                >
                  <span className="truncate">{tab.title}</span>
                </button>
              ))}
          </div>
        </PopoverContent>
      </Popover>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        aria-label={t('databases.workbench.closeSplit')}
        onClick={() => setSecondaryTabId(null)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <div
      ref={splitContainerRef}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background',
        secondaryTab && splitDirection === 'vertical' ? 'flex-col' : 'flex-row',
      )}
    >
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={secondaryTab ? { flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 0 } : { flex: '1 1 0%' }}
      >
        <DatabaseTabPane
          tab={activeTab}
          workbench={workbench}
          connections={connections}
          onUpdateConnections={onUpdateConnections}
          sqlHistory={sqlHistory}
          schemaWidth={schemaWidth}
          onSchemaResizeStart={beginSchemaResize}
          autoFocus
          headerActions={splitControls}
        />
      </div>
      {secondaryTab ? (
        <>
          <div
            role="separator"
            aria-orientation={splitDirection === 'vertical' ? 'horizontal' : 'vertical'}
            aria-label={t('databases.schema.resize')}
            className={cn(
              'shrink-0 bg-border/60 hover:bg-primary/40',
              splitDirection === 'vertical' ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize',
            )}
            onMouseDown={beginSplitResize}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <DatabaseTabPane
              key={secondaryTab.id}
              tab={secondaryTab}
              workbench={workbench}
              connections={connections}
              onUpdateConnections={onUpdateConnections}
              sqlHistory={sqlHistory}
              schemaWidth={schemaWidth}
              onSchemaResizeStart={beginSchemaResize}
              headerActions={secondaryControls}
            />
          </div>
        </>
      ) : null}
    </div>
  );
};


/** Text input with an inline clear button, used by the schema and structure filters. */
const ClearableInput: React.FC<{
  className?: string;
  placeholder: string;
  value: string;
  clearLabel: string;
  onChange: (value: string) => void;
}> = ({ className, placeholder, value, clearLabel, onChange }) => (
  <div className="relative">
    <Input
      className={cn(className, value ? 'pr-7' : undefined)}
      placeholder={placeholder}
      value={value}
      aria-label={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
    {value ? (
      <button
        type="button"
        aria-label={clearLabel}
        title={clearLabel}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => onChange('')}
      >
        <X className="h-3 w-3" />
      </button>
    ) : null}
  </div>
);

const ROW_LIMIT_PRESETS = [100, 500, 1000, 2000, 5000];
/** Seconds a statement may run. The first one is the default. */
const QUERY_TIMEOUT_PRESETS = [30, 120, 600, 1800, 3600, 7200];

/**
 * Editable row limit: the number is a text field (type any value), the chevron
 * opens the usual presets.
 */
const RowLimitControl: React.FC<{
  value: number;
  label: string;
  onChange: (value: number) => void;
}> = ({ value, label, onChange }) => {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(value));
      return;
    }
    onChange(parsed);
  };

  return (
    <div className="flex items-center overflow-hidden rounded border border-border/60">
      <input
        className="h-5 w-14 bg-transparent px-1 text-right text-[11px] tabular-nums outline-none focus:bg-muted/40"
        inputMode="numeric"
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(draft);
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-5 w-4 items-center justify-center border-l border-border/60 text-muted-foreground hover:bg-muted/60"
            aria-label={label}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-24 p-1">
          <div className="flex flex-col">
            {ROW_LIMIT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={cn(
                  'rounded px-2 py-1 text-left text-[11px] tabular-nums hover:bg-muted',
                  preset === value ? 'bg-primary/10 font-medium' : '',
                )}
                onClick={() => onChange(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

interface SchemaPanelProps {
  tabId: string;
  tables: DatabaseTab['tables'];
  loading: boolean;
  error?: string;
  width: number;
  onRefresh: () => void;
  onPreview: (table: DbTableRef) => void;
  onShowStructure: (table: DbTableRef) => void;
  t: ReturnType<typeof useI18n>['t'];
}

const SCHEMA_ROW_HEIGHT = 22;

type SchemaListItem =
  | { kind: 'schema'; key: string; schema: string; count: number }
  | { kind: 'table'; key: string; table: DbTableRef };

/**
 * The table list of a connection. Memoized on the table list itself (not on
 * the tab, which changes with every keystroke in the editor) and virtualized:
 * a database with thousands of tables used to mount a row, two icons and a
 * tooltip for each of them and re-render them all while typing SQL.
 */
const SchemaPanel = memo(function SchemaPanel({
  tabId,
  tables,
  loading,
  error,
  width,
  onRefresh,
  onPreview,
  onShowStructure,
  t,
}: SchemaPanelProps) {
  const [tableQuery, setTableQuery] = useState('');
  useEffect(() => {
    setTableQuery('');
  }, [tabId]);
  // Typing in the filter stays instant; the list catches up right after.
  const deferredQuery = useDeferredValue(tableQuery);
  const visibleTables = useMemo(() => filterTables(tables ?? [], deferredQuery), [tables, deferredQuery]);
  const items = useMemo(() => {
    const bySchema = new Map<string, DbTableRef[]>();
    for (const table of visibleTables) {
      const list = bySchema.get(table.schema);
      if (list) list.push(table);
      else bySchema.set(table.schema, [table]);
    }
    const flat: SchemaListItem[] = [];
    for (const [schema, list] of bySchema) {
      if (bySchema.size > 1) flat.push({ kind: 'schema', key: `schema:${schema}`, schema, count: list.length });
      for (const table of list) flat.push({ kind: 'table', key: `${table.schema}.${table.name}`, table });
    }
    return flat;
  }, [visibleTables]);
  const previewLabel = t('databases.schema.preview');

  return (
    <div className="flex shrink-0 flex-col border-r border-border/60" style={{ width }}>
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-2 py-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('databases.schema.title')}
          {tables && tables.length > 0 ? (
            <span className="font-normal tabular-nums opacity-70">
              {visibleTables.length === tables.length ? tables.length : `${visibleTables.length} / ${tables.length}`}
            </span>
          ) : null}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0"
              disabled={loading}
              onClick={onRefresh}
            >
              <RotateCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('databases.schema.refresh')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="shrink-0 px-1 pt-1">
        <ClearableInput
          className="h-6 text-[11px]"
          placeholder={t('databases.schema.searchPlaceholder')}
          value={tableQuery}
          clearLabel={t('databases.searchClear')}
          onChange={setTableQuery}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-1">
        {error ? (
          <p className="nc-anim-fade-in px-1 py-2 text-[11px] text-destructive">{error}</p>
        ) : items.length === 0 && loading && !tableQuery.trim() ? (
          <div className="space-y-1.5 px-1 py-1.5" aria-busy="true" aria-label={t('databases.schema.loading')}>
            {[72, 56, 84, 64, 48, 76].map((barWidth, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <span className="h-3 w-3 shrink-0 animate-pulse rounded-sm bg-muted" />
                <span
                  className="h-2.5 animate-pulse rounded-sm bg-muted"
                  style={{ width: `${barWidth}%`, animationDelay: `${index * 90}ms` }}
                />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {loading
              ? t('databases.schema.loading')
              : tableQuery.trim()
                ? t('databases.schema.noMatches')
                : t('databases.schema.empty')}
          </p>
        ) : (
          <FixedSizeVirtualList
            items={items}
            itemHeight={SCHEMA_ROW_HEIGHT}
            overscan={12}
            className="min-h-0 flex-1"
            getItemKey={(item: SchemaListItem) => item.key}
            renderItem={(item: SchemaListItem) =>
              item.kind === 'schema' ? (
                <p className="flex h-[22px] items-center gap-1.5 truncate px-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                  <span className="truncate">{item.schema}</span>
                  <span className="tabular-nums opacity-70">{item.count}</span>
                </p>
              ) : (
                <div className="group flex h-[22px] w-full items-center gap-1 rounded px-1 text-[11px] hover:bg-secondary">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    title={`${item.table.schema}.${item.table.name}`}
                    onClick={() => onShowStructure(item.table)}
                  >
                    {item.table.type === 'view' ? (
                      <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <Table2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{item.table.name}</span>
                  </button>
                  {/* Native title instead of a tooltip component per row. */}
                  <button
                    type="button"
                    className="rounded p-0.5 opacity-0 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={previewLabel}
                    title={previewLabel}
                    onClick={() => onPreview(item.table)}
                  >
                    <Play className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              )
            }
          />
        )}
      </div>
    </div>
  );
});

interface StructurePanelProps {
  structure: NonNullable<DatabaseTab['structure']>;
  onClose: () => void;
  onPreview: () => void;
  t: ReturnType<typeof useI18n>['t'];
}

const StructurePanel: React.FC<StructurePanelProps> = ({ structure, onClose, onPreview, t }) => {
  const { table, columns, loading, error } = structure;
  const [columnQuery, setColumnQuery] = useState('');
  useEffect(() => {
    setColumnQuery('');
  }, [table.schema, table.name]);
  const visibleColumns = useMemo(
    () => filterTables(columns, columnQuery),
    [columns, columnQuery],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-secondary/40 px-3 py-1.5">
        <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-xs font-medium">{`${table.schema}.${table.name}`}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('databases.structure.title')}
        </span>
        <div className="ml-2 w-40">
          <ClearableInput
            className="h-6 text-[11px]"
            placeholder={t('databases.structure.searchPlaceholder')}
            value={columnQuery}
            clearLabel={t('databases.searchClear')}
            onChange={setColumnQuery}
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onPreview}>
            <Play className="mr-1 h-3 w-3" />
            {t('databases.schema.preview')}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label={t('common.close')} onClick={onClose}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {error ? (
        <p className="px-3 py-2 text-xs text-destructive">{error}</p>
      ) : loading ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('databases.structure.loading')}</p>
      ) : visibleColumns.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('databases.structure.empty')}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 grid grid-cols-[minmax(160px,2fr)_minmax(120px,1.5fr)_80px] border-b border-border/60 bg-secondary/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>{t('databases.structure.column')}</span>
            <span>{t('databases.structure.type')}</span>
            <span>{t('databases.structure.nullable')}</span>
          </div>
          {visibleColumns.map((column) => (
            <div
              key={column.name}
              className="grid grid-cols-[minmax(160px,2fr)_minmax(120px,1.5fr)_80px] items-center border-b border-border/30 px-3 py-1 text-xs"
            >
              <span className="truncate font-mono">{column.name}</span>
              <span className="truncate text-muted-foreground">{column.type ?? ''}</span>
              <span className="text-muted-foreground">{column.nullable === false ? 'NOT NULL' : 'NULL'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface ResultGridProps {
  columns: DbQueryResult['columns'];
  /** Rows for the current page, already ordered/sliced, with their source index. */
  rows: readonly { cells: DbCellValue[]; sourceIndex: number }[];
  /** Resolved pixel width per rendered column (after manual overrides). */
  columnWidths: number[];
  t: ReturnType<typeof useI18n>['t'];
  /** In-place editing is only offered when the row has a usable primary key. */
  editable?: boolean;
  onUpdateCell?: (sourceIndex: number, column: string, value: string | null) => Promise<boolean>;
  onDeleteRow?: (sourceIndex: number) => Promise<boolean>;
  /** Fired while dragging a header divider; width is already in pixels. */
  onResizeColumn?: (index: number, width: number) => void;
  onResizeCommit?: () => void;
  /** Active sort column, applied to the whole result (not just this page). */
  sort?: ResultSort | null;
  onToggleSort?: (columnIndex: number) => void;
  /** Columns picked for copy/export; clicking a header with a modifier toggles it. */
  selectedColumns?: readonly number[];
  onSelectColumn?: (columnIndex: number, additive: boolean) => void;
  /** Cell the search jumped to, highlighted in place. */
  highlight?: { sourceIndex: number; columnIndex: number } | null;
  onCopyCell?: (text: string) => void;
  /** Copy the given columns (empty list = every column) through the context menu. */
  onCopyColumns?: (columnIndexes: number[]) => void;
  /** Copy one row (every column) through the context menu. */
  onCopyRow?: (sourceIndex: number) => void;
  /** Drops the column selection from the context menu. */
  onClearSelection?: () => void;
  /** 1-based number of the first row on this page (keeps numbers stable across pages). */
  rowNumberStart?: number;
}

/** Last path segment, for both / and \\ separators. */
function sqlFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/** A tab title that is safe to offer as a file name on every platform. */
function sanitizeSqlFileName(title: string): string {
  const cleaned = Array.from(title, (char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '-' : char))
    .join('')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
  return cleaned.slice(0, 80) || 'query';
}

const ACTION_COLUMN_WIDTH = 32;
interface ResultRowProps {
  row: { cells: DbCellValue[]; sourceIndex: number };
  /** 1-based number shown in the pinned gutter. */
  rowNumber: number;
  striped: boolean;
  template: string;
  editable: boolean;
  saving: boolean;
  selectedColumns: readonly number[];
  /** Pending edit for this row only, so other rows keep a stable prop set. */
  editing: { sourceIndex: number; cell: number; draft: string } | null;
  highlight: { sourceIndex: number; columnIndex: number } | null;
  t: ReturnType<typeof useI18n>['t'];
  onDelete: (sourceIndex: number) => void;
  onCopyCell: (text: string) => void;
  onPreview: (columnIndex: number, text: string) => void;
  onOpenMenu: (payload: { x: number; y: number; columnIndex: number; sourceIndex: number }) => void;
  onBeginEdit: (sourceIndex: number, cell: number, draft: string) => void;
  onEditDraft: (draft: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
}

// Memoised so wheel scrolling only re-diffs rows entering/leaving the window
// instead of every visible cell.
const ResultRow = memo(function ResultRow(props: ResultRowProps) {
  const {
    row,
    rowNumber,
    striped,
    template,
    editable,
    saving,
    selectedColumns,
    editing,
    highlight,
    t,
    onDelete,
    onCopyCell,
    onPreview,
    onOpenMenu,
    onBeginEdit,
    onEditDraft,
    onCommitEdit,
    onCancelEdit,
  } = props;
  return (
        <div
          className={cn(
            'group grid h-7 items-center text-xs',
            striped ? 'bg-secondary/20' : 'bg-transparent',
          )}
          style={{ gridTemplateColumns: template }}
        >
          <div className="sticky left-0 z-[1] h-7 select-none border-r border-border/60 bg-background px-2 text-right text-[11px] leading-7 tabular-nums text-muted-foreground/60">
            {rowNumber}
          </div>
          {editable ? (
            <div className="flex items-center justify-center">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                aria-label={t('databases.workbench.deleteRow')}
                disabled={saving}
                onClick={() => onDelete(row.sourceIndex)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ) : null}
          {row.cells.map((value, cellIndex) => {
            const isEditing =
              editing?.cell === cellIndex;
            const isMatch =
              highlight?.sourceIndex === row.sourceIndex && highlight?.columnIndex === cellIndex;
            if (isEditing) {
              return (
                <input
                  key={cellIndex}
                  autoFocus
                  className="h-6 w-full rounded border border-primary/60 bg-background px-2 font-mono text-xs outline-none"
                  value={editing?.draft ?? ''}
                  disabled={saving}
                  onChange={(event) => onEditDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onCommitEdit();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      onCancelEdit();
                    }
                  }}
                  onBlur={onCommitEdit}
                />
              );
            }
            const text = cellText(value);
            // Any non-empty cell can be previewed; long values just need it most.
            const canPreview = value !== null && value !== undefined;
            return (
              <div
                key={cellIndex}
                className={cn(
                  'relative truncate px-3 font-mono',
                  // The preview affordance is a CSS pseudo-element (see
                  // .nc-result-cell-preview): a real button + icon per cell
                  // quadrupled the DOM and made every hover repaint slow.
                  canPreview && 'nc-result-cell-preview pr-7',
                  value !== null && 'cursor-pointer hover:bg-secondary/40',
                  value === null && 'italic text-muted-foreground/70',
                  typeof value === 'number' && 'text-right tabular-nums',
                  selectedColumns.includes(cellIndex) && 'bg-primary/5',
                  isMatch && 'bg-amber-400/30 ring-1 ring-inset ring-amber-500/70',
                )}
                title={canPreview ? `${text}\n\n${t('databases.workbench.previewCell')} ↗` : text}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onOpenMenu({
                    x: event.clientX,
                    y: event.clientY,
                    columnIndex: cellIndex,
                    sourceIndex: row.sourceIndex,
                  });
                }}
                onDoubleClick={() => {
                  if (!editable || saving) return;
                  onBeginEdit(row.sourceIndex, cellIndex, cellText(value));
                }}
                onClick={(event) => {
                  if (canPreview) {
                    const box = event.currentTarget.getBoundingClientRect();
                    if (box.right - event.clientX <= RESULT_CELL_PREVIEW_ZONE) {
                      onPreview(cellIndex, text);
                      return;
                    }
                  }
                  if (value === null) return;
                  onCopyCell(String(value));
                }}
              >
                {text}
              </div>
            );
          })}
        </div>
  );
});

const ROW_NUMBER_WIDTH = 44;
const ROW_NUMBER_ITEM_HEIGHT = 28;
// Scrolling runs on the compositor and can outrun a React render by a frame or
// two; this many rows above and below the viewport keep that gap filled. Not
// more: hovering repaints the whole grid layer, which scales with mounted rows.
const RESULT_ROW_OVERSCAN = 10;
// Width of the hover icon's click zone at the right edge of a cell.
const RESULT_CELL_PREVIEW_ZONE = 24;
// The header and the row numbers are sticky inside the scroller, so rows pass
// underneath them: they need an opaque base under the translucent tint.
const RESULT_HEADER_SURFACE: React.CSSProperties = {
  backgroundImage: 'linear-gradient(hsl(var(--secondary) / 0.6), hsl(var(--secondary) / 0.6))',
};

const ResultGrid: React.FC<ResultGridProps> = ({
  columns,
  rows,
  columnWidths,
  t,
  editable = false,
  onUpdateCell,
  onDeleteRow,
  onResizeColumn,
  onResizeCommit,
  sort,
  onToggleSort,
  selectedColumns = [],
  onSelectColumn,
  highlight,
  onCopyCell,
  onCopyColumns,
  onCopyRow,
  onClearSelection,
  rowNumberStart = 0,
}) => {
  const [editing, setEditing] = useState<{ sourceIndex: number; cell: number; draft: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ sourceIndex: number } | null>(null);
  const [saving, setSaving] = useState(false);
  // Row props must stay referentially stable or the memoised rows re-render on
  // every scroll tick.
  const commitEditRef = useRef<() => void>(() => {});
  const handleDeleteRow = useCallback((sourceIndex: number) => {
    setPendingDelete({ sourceIndex });
  }, []);
  const handleCopyCell = useCallback((text: string) => {
    onCopyCell?.(text);
  }, [onCopyCell]);
  const noopCopyCell = useCallback(() => {}, []);
  const handlePreviewCell = useCallback((columnIndex: number, value: string) => {
    setPreview({ columnIndex, value });
  }, []);
  const handleOpenMenu = useCallback(
    (payload: { x: number; y: number; columnIndex: number; sourceIndex: number }) => {
      setMenu(payload);
    },
    [],
  );
  const handleBeginEdit = useCallback((sourceIndex: number, cell: number, draft: string) => {
    setEditing({ sourceIndex, cell, draft });
  }, []);
  const handleEditDraft = useCallback((draft: string) => {
    setEditing((prev) => (prev ? { ...prev, draft } : prev));
  }, []);
  const handleCommitEdit = useCallback(() => {
    commitEditRef.current();
  }, []);
  const handleCancelEdit = useCallback(() => {
    setEditing(null);
  }, []);
  const [menu, setMenu] = useState<
    { x: number; y: number; columnIndex: number | null; sourceIndex: number | null } | null
  >(null);
  const [preview, setPreview] = useState<{ columnIndex: number; value: string } | null>(null);
  const listRef = useRef<FixedSizeVirtualListHandle | null>(null);

  // A context menu that survives scrolls would point at the wrong row.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // Jump to the highlighted row whenever the search moves to a new page.
  useEffect(() => {
    if (!highlight) return;
    const index = rows.findIndex((entry) => entry.sourceIndex === highlight.sourceIndex);
    if (index < 0) return;
    listRef.current?.scrollToIndex(index, 'center');
  }, [highlight, rows]);

  if (columns.length === 0) {
    return null;
  }

  const template = [
    `${ROW_NUMBER_WIDTH}px`,
    editable ? `${ACTION_COLUMN_WIDTH}px` : null,
    ...columnWidths.map((entry) => `${Math.round(entry)}px`),
  ]
    .filter(Boolean)
    .join(' ');
  const width = columnWidths.reduce((total, entry) => total + Math.round(entry), 0)
    + ROW_NUMBER_WIDTH
    + (editable ? ACTION_COLUMN_WIDTH : 0);

  const contentSize: React.CSSProperties = {
    minWidth: '100%',
    width: width > 0 ? `${width}px` : undefined,
  };

  const commitEdit = async () => {
    if (!editing || !onUpdateCell) {
      setEditing(null);
      return;
    }
    const column = columns[editing.cell];
    const row = rows.find((entry) => entry.sourceIndex === editing.sourceIndex);
    const original = row?.cells[editing.cell];
    const draft = editing.draft;
    const next = draft === '' && (original === null || original === undefined) ? null : draft;
    if (String(original ?? '') === String(next ?? '')) {
      setEditing(null);
      return;
    }
    setSaving(true);
    const applied = await onUpdateCell(editing.sourceIndex, column.name, next);
    setSaving(false);
    setEditing(null);
    if (applied) toast.success(t('databases.workbench.rowUpdated'));
    else toast.error(t('databases.workbench.rowUpdateFailed'));
  };

  const runMenuAction = (action: 'cell' | 'row' | 'column' | 'all') => {
    if (!menu) return;
    if (action === 'cell' && menu.sourceIndex !== null && menu.columnIndex !== null) {
      const row = rows.find((entry) => entry.sourceIndex === menu.sourceIndex);
      const value = row?.cells[menu.columnIndex];
      if (value !== null && value !== undefined) onCopyCell?.(String(value));
    } else if (action === 'row' && menu.sourceIndex !== null) {
      onCopyRow?.(menu.sourceIndex);
    } else if (action === 'column' && menu.columnIndex !== null) {
      onCopyColumns?.(selectedColumns.length > 0 ? [...selectedColumns] : [menu.columnIndex]);
    } else if (action === 'all') {
      onCopyColumns?.([]);
    }
    setMenu(null);
  };

  commitEditRef.current = () => {
    void commitEdit();
  };

  const commitDelete = async () => {
    if (!pendingDelete || !onDeleteRow) {
      setPendingDelete(null);
      return;
    }
    setSaving(true);
    const applied = await onDeleteRow(pendingDelete.sourceIndex);
    setSaving(false);
    setPendingDelete(null);
    if (applied) toast.success(t('databases.workbench.rowDeleted'));
    else toast.error(t('databases.workbench.rowDeleteFailed'));
  };

  return (
    <>
      <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
          <FixedSizeVirtualList
            ref={listRef}
            items={rows as { cells: DbCellValue[]; sourceIndex: number }[]}
            itemHeight={ROW_NUMBER_ITEM_HEIGHT}
            headerHeight={ROW_NUMBER_ITEM_HEIGHT}
            overscan={RESULT_ROW_OVERSCAN}
            // One scroller for both axes: the header (sticky top) and the row
            // numbers (sticky left) are pinned by the compositor, so nothing
            // has to be mirrored from scroll events.
            className="min-h-0 flex-1 overflow-auto [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-solid [&::-webkit-scrollbar-thumb]:border-background [&::-webkit-scrollbar-thumb]:bg-clip-padding [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-corner]:bg-transparent"
            contentStyle={contentSize}
            getItemKey={(_row, index) => String(index)}
            header={
          <div
            className="sticky top-0 z-10 grid h-7 shrink-0 border-b border-border/60 bg-background"
            style={{ ...RESULT_HEADER_SURFACE, ...contentSize, gridTemplateColumns: template }}
          >
            <div
              className="sticky left-0 z-[1] border-r border-border/60 bg-background px-2 py-1.5 text-right text-[11px] font-semibold tabular-nums text-muted-foreground/60"
              style={RESULT_HEADER_SURFACE}
              title={t('databases.workbench.rowNumber')}
            >
              #
            </div>
            {editable ? <div className="px-1 py-1.5" /> : null}
            {columns.map((column, index) => {
              const isSorted = sort?.columnIndex === index;
              const selected = selectedColumns.includes(index);
              return (
                <div
                  key={`${column.name}-${index}`}
                  className={cn(
                    'group/head relative flex min-w-0 items-center gap-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide',
                    selected ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
                  )}
                  title={
                    column.type
                      ? `${column.name} · ${column.type}`
                      : `${column.name} — ${t('databases.workbench.sortHint')}`
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, columnIndex: index, sourceIndex: null });
                  }}
                >
                  <button
                    type="button"
                    aria-label={
                      selected
                        ? t('databases.workbench.deselectColumn', { column: column.name })
                        : t('databases.workbench.selectColumn', { column: column.name })
                    }
                    aria-pressed={selected}
                    title={
                      selected
                        ? t('databases.workbench.deselectColumn', { column: column.name })
                        : t('databases.workbench.selectColumn', { column: column.name })
                    }
                    className={cn(
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border/70 text-transparent hover:border-primary/70 group-hover/head:opacity-100 opacity-0',
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectColumn?.(index, true);
                    }}
                  >
                    <Check className="h-2.5 w-2.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 text-left uppercase tracking-wide hover:text-foreground"
                    aria-label={t('databases.workbench.sortByColumn', { column: column.name })}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey) {
                        event.preventDefault();
                        onSelectColumn?.(index, true);
                        return;
                      }
                      onToggleSort?.(index);
                    }}
                  >
                    <span className="truncate">{column.name}</span>
                    {isSorted ? (
                      sort?.direction === 'desc' ? (
                        <ArrowDown className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                      ) : (
                        <ArrowUp className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                      )
                    ) : null}
                    {selected ? <CheckCircle2 className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" /> : null}
                  </button>
                  {onResizeColumn ? (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      className="absolute -right-0.5 top-0 h-full w-1.5 cursor-col-resize select-none bg-transparent hover:bg-primary/40"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        const startX = event.clientX;
                        const startWidth = columnWidths[index] ?? MIN_COLUMN_WIDTH;
                        const target = event.currentTarget;
                        target.setPointerCapture(event.pointerId);
                        const move = (moveEvent: PointerEvent) => {
                          onResizeColumn(index, startWidth + (moveEvent.clientX - startX));
                        };
                        const up = () => {
                          target.removeEventListener('pointermove', move);
                          target.removeEventListener('pointerup', up);
                          target.removeEventListener('pointercancel', up);
                          onResizeCommit?.();
                        };
                        target.addEventListener('pointermove', move);
                        target.addEventListener('pointerup', up);
                        target.addEventListener('pointercancel', up);
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
            }
            renderItem={(row, rowIndex) => (
              <ResultRow
                row={row}
                rowNumber={rowNumberStart + rowIndex + 1}
                striped={rowIndex % 2 === 1}
                template={template}
                editable={editable}
                saving={saving}
                selectedColumns={selectedColumns}
                editing={editing?.sourceIndex === row.sourceIndex ? editing : null}
                highlight={highlight}
                t={t}
                onDelete={handleDeleteRow}
                onCopyCell={onCopyCell ? handleCopyCell : noopCopyCell}
                onPreview={handlePreviewCell}
                onOpenMenu={handleOpenMenu}
                onBeginEdit={handleBeginEdit}
                onEditDraft={handleEditDraft}
                onCommitEdit={handleCommitEdit}
                onCancelEdit={handleCancelEdit}
              />
            )}
          />
      </div>
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="flex max-h-[80vh] w-[min(760px,calc(100vw-2rem))] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
              {preview ? columns[preview.columnIndex]?.name ?? t('databases.workbench.previewTitle') : t('databases.workbench.previewTitle')}
              <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                {t('databases.workbench.previewChars', { count: String(preview?.value.length ?? 0) })}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto rounded border border-border/60 bg-muted/30 p-2">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
              {preview?.value ?? ''}
            </pre>
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 pt-3">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => {
                if (!preview) return;
                onCopyCell?.(preview.value);
              }}
            >
              <Check className="mr-1 h-3 w-3" />
              {t('databases.workbench.contextCopyCell')}
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={() => setPreview(null)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {menu ? createPortal(
        <div
          role="menu"
          className="fixed z-50 min-w-[168px] rounded-md border border-border/70 bg-popover p-1 text-xs shadow-lg"
          style={{
            left: Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 190),
            top: Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 140),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {menu.sourceIndex !== null && menu.columnIndex !== null ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
                onClick={() => runMenuAction('cell')}
              >
                {t('databases.workbench.contextCopyCell')}
              </button>
              {menu.columnIndex !== null && menu.sourceIndex !== null ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
                  onClick={() => {
                    const target = rows.find((row) => row.sourceIndex === menu.sourceIndex);
                    setPreview({
                      columnIndex: menu.columnIndex as number,
                      value: cellText(target?.cells[menu.columnIndex] ?? null),
                    });
                    setMenu(null);
                  }}
                >
                  {t('databases.workbench.previewCell')}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
                onClick={() => runMenuAction('row')}
              >
                {t('databases.workbench.contextCopyRow')}
              </button>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
            onClick={() => runMenuAction('column')}
          >
            {selectedColumns.length > 1
              ? t('databases.workbench.contextCopyColumns', { count: String(selectedColumns.length) })
              : t('databases.workbench.contextCopyColumn')}
          </button>
          {menu.sourceIndex === null && menu.columnIndex !== null ? (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
              onClick={() => {
                if (menu.columnIndex !== null) onCopyColumns?.([menu.columnIndex]);
                setMenu(null);
              }}
            >
              {t('databases.workbench.contextCopyThisColumn')}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
            onClick={() => runMenuAction('all')}
          >
            {t('databases.workbench.contextCopyAll')}
          </button>
          {menu.columnIndex !== null ? (
            <>
              <div className="my-1 h-px bg-border/70" />
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
                onClick={() => {
                  if (menu.columnIndex !== null) onSelectColumn?.(menu.columnIndex, true);
                  setMenu(null);
                }}
              >
                {selectedColumns.includes(menu.columnIndex)
                  ? t('databases.workbench.deselectMenu')
                  : t('databases.workbench.selectMenu')}
              </button>
              {selectedColumns.length > 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-secondary"
                  onClick={() => {
                    onClearSelection?.();
                    setMenu(null);
                  }}
                >
                  {t('databases.workbench.clearColumnSelection')}
                </button>
              ) : null}
            </>
          ) : null}
        </div>,
        document.body,
      ) : null}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('databases.workbench.deleteRowTitle')}
        message={t('databases.workbench.deleteRowConfirmMessage')}
        confirmLabel={t('databases.workbench.deleteRow')}
        destructive
        busy={saving}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        onConfirm={() => void commitDelete()}
      />
    </>
  );
};
