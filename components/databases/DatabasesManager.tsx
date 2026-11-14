/**
 * Vault section for database connections. Owns the list/search surface and
 * delegates editing to DatabaseConnectionDialog; opening a connection hands the
 * entity to the workbench layer.
 */

import {
  ChevronDown,
  Copy,
  Database,
  Download,
  Pencil,
  Play,
  PlugZap,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  databaseDisplayTarget,
  sanitizeDatabaseConnection,
  sortDatabaseConnections,
  type DatabaseConnection,
  type DatabaseKind,
} from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  VaultHeaderSearch,
  VaultPageHeader,
  vaultHeaderIconButtonClass,
  vaultHeaderSecondaryButtonClass,
  vaultSectionTitleClass,
} from '../vault/VaultPageHeader';
import { VaultEntityIcon } from '../vault/VaultEntityIcon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import type { DbTestConnectionResult } from '../../domain/models';
import { DatabaseConnectionDialog } from './DatabaseConnectionDialog';
import { JdbcDriversDialog } from './JdbcDriversDialog';
import type { DatabaseColorTag, JdbcDriver } from '../../domain/models';
import { mergeImported } from '../../domain/database/connectionTransfer';
import { useDatabaseConfigTransfer } from '../../application/state/useDatabaseConfigTransfer';
import { toast } from '../ui/toast';

/** Filled tiles, like the key / proxy / snippet icons elsewhere in the vault. */
const KIND_ICON_CLASS: Record<DatabaseKind, string> = {
  postgresql: 'bg-sky-600 text-white dark:bg-sky-400 dark:text-slate-950',
  mysql: 'bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950',
  mariadb: 'bg-orange-600 text-white dark:bg-orange-400 dark:text-slate-950',
  oracle: 'bg-red-600 text-white dark:bg-red-400 dark:text-slate-950',
  sqlserver: 'bg-blue-600 text-white dark:bg-blue-400 dark:text-slate-950',
  sqlite: 'bg-emerald-600 text-white dark:bg-emerald-400 dark:text-slate-950',
  jdbc: 'bg-violet-600 text-white dark:bg-violet-400 dark:text-slate-950',
};

const COLOR_TAG_CLASS: Record<Exclude<DatabaseColorTag, 'none'>, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  yellow: 'bg-amber-400',
  green: 'bg-emerald-500',
  blue: 'bg-sky-500',
  purple: 'bg-violet-500',
};

interface DatabasesManagerProps {
  dbConnections: DatabaseConnection[];
  onUpdateDbConnections: (connections: DatabaseConnection[]) => void;
  onOpenConnection: (connection: DatabaseConnection) => void;
  /** SSH hosts offered as jump boxes for new connections. */
  sshHosts?: { id: string; label: string }[];
  /** Runs a test dial, opening the SSH tunnel first when the draft asks for one. */
  onTestConnection?: (draft: DatabaseConnection) => Promise<DbTestConnectionResult>;
  /** Registered JDBC drivers, shared by every JDBC connection. */
  jdbcDrivers?: JdbcDriver[];
  onUpdateJdbcDrivers?: (drivers: JdbcDriver[]) => void;
}

export const DatabasesManager: React.FC<DatabasesManagerProps> = ({
  dbConnections,
  onUpdateDbConnections,
  onOpenConnection,
  sshHosts,
  onTestConnection,
  jdbcDrivers = [],
  onUpdateJdbcDrivers,
}) => {
  const { t } = useI18n();
  const transfer = useDatabaseConfigTransfer();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<DatabaseConnection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DatabaseConnection | null>(null);
  const [driversOpen, setDriversOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [transferring, setTransferring] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);


  const connections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = sortDatabaseConnections(dbConnections);
    if (!needle) return sorted;
    return sorted.filter((connection) =>
      [connection.label, connection.host, connection.database, connection.sqlitePath]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [dbConnections, query]);

  const grouped = useMemo(() => {
    const sections = new Map<string, DatabaseConnection[]>();
    for (const connection of connections) {
      const key = connection.group?.trim() ?? '';
      const bucket = sections.get(key);
      if (bucket) bucket.push(connection);
      else sections.set(key, [connection]);
    }
    return [...sections.entries()]
      .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
      .map(([group, items]) => ({ group, items }));
  }, [connections]);

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const exportConfig = async () => {
    setTransferring(true);
    try {
      const saved = await transfer.exportToFile(dbConnections, jdbcDrivers);
      if (saved.ok !== true) {
        toast.error(t('databases.transfer.exportFailed', { error: (saved as { error?: string }).error ?? '' }));
        return;
      }
      if (saved.canceled) return;
      toast.success(t('databases.transfer.exported', { count: String(dbConnections.length) }));
    } finally {
      setTransferring(false);
    }
  };

  const importConfig = async (file: File) => {
    setTransferring(true);
    try {
      const parsed = await transfer.readConfigFile(file);
      if (parsed.ok !== true) {
        toast.error(t('databases.transfer.importInvalid'));
        return;
      }
      const mergedConnections = mergeImported(dbConnections, parsed.value.connections);
      if (mergedConnections.added + mergedConnections.updated > 0) {
        onUpdateDbConnections(mergedConnections.items.map((entry) => sanitizeDatabaseConnection(entry) as DatabaseConnection));
      }
      if (onUpdateJdbcDrivers && parsed.value.drivers.length > 0) {
        const mergedDrivers = mergeImported(jdbcDrivers, parsed.value.drivers);
        onUpdateJdbcDrivers(mergedDrivers.items);
      }
      toast.success(
        t('databases.transfer.imported', {
          added: String(mergedConnections.added),
          updated: String(mergedConnections.updated),
        }),
      );
    } catch {
      toast.error(t('databases.transfer.importInvalid'));
    } finally {
      setTransferring(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (connection: DatabaseConnection) => {
    setEditing(connection);
    setDialogOpen(true);
  };

  const save = (connection: DatabaseConnection) => {
    const exists = dbConnections.some((entry) => entry.id === connection.id);
    const next = exists
      ? dbConnections.map((entry) => (entry.id === connection.id ? connection : entry))
      : [...dbConnections, connection];
    onUpdateDbConnections(next);
    setDialogOpen(false);
    setEditing(null);
  };

  const clone = (connection: DatabaseConnection) => {
    const copy = sanitizeDatabaseConnection({
      ...connection,
      id: crypto.randomUUID(),
      label: `${connection.label} (${t('databases.copySuffix')})`,
      createdAt: Date.now(),
      updatedAt: undefined,
      lastUsedAt: undefined,
    });
    onUpdateDbConnections([...dbConnections, copy]);
  };

  const open = (connection: DatabaseConnection) => {
    onUpdateDbConnections(
      dbConnections.map((entry) =>
        entry.id === connection.id ? { ...entry, lastUsedAt: Date.now() } : entry,
      ),
    );
    onOpenConnection(connection);
  };

  const remove = (connection: DatabaseConnection) => {
    onUpdateDbConnections(dbConnections.filter((entry) => entry.id !== connection.id));
    setPendingDelete(null);
  };

  return (
    <div className="flex h-full flex-col">
      <VaultPageHeader>
        <Button onClick={openCreate} variant="secondary" className={vaultHeaderSecondaryButtonClass}>
          <Plus size={14} />
          {t('databases.new')}
        </Button>
        <div className="ml-auto flex min-w-0 flex-shrink items-center gap-2">
          <VaultHeaderSearch
            aria-label={t('databases.search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('databases.search.placeholder')}
            className="w-64 flex-shrink"
          />
          {onUpdateJdbcDrivers ? (
            <Button
              variant="secondary"
              className={cn(vaultHeaderSecondaryButtonClass, 'flex-shrink-0')}
              onClick={() => setDriversOpen(true)}
            >
              <PlugZap size={14} />
              {t('databases.drivers.open')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className={cn(vaultHeaderIconButtonClass, 'flex-shrink-0')}
            aria-label={t('databases.transfer.import')}
            title={t('databases.transfer.import')}
            disabled={transferring}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(vaultHeaderIconButtonClass, 'flex-shrink-0')}
            aria-label={t('databases.transfer.export')}
            title={t('databases.transfer.export')}
            disabled={transferring || dbConnections.length === 0}
            onClick={() => void exportConfig()}
          >
            <Download size={16} />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importConfig(file);
            }}
          />
        </div>
      </VaultPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <h2 className={vaultSectionTitleClass}>{t('databases.title')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('databases.count', { count: String(dbConnections.length) })}
            </span>
          </div>
        {connections.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center text-muted-foreground">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary/80">
              <Database size={32} className="opacity-60" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-foreground">{t('databases.empty.title')}</h3>
            <p className="mb-4 max-w-sm text-center text-sm">{t('databases.empty.description')}</p>
            <Button onClick={openCreate}>
              <Plus size={14} className="mr-2" />
              {t('databases.new')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {grouped.map(({ group, items }) => {
              const collapsed = collapsedGroups.has(group);
              return (
                <div key={group || '__ungrouped'}>
                  {grouped.length > 1 || group ? (
                    <button
                      type="button"
                      className="mb-2 flex w-full items-center gap-1.5 rounded text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroup(group)}
                    >
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform duration-200', collapsed && '-rotate-90')}
                      />
                      <span className="truncate">{group || t('databases.groupUngrouped')}</span>
                      <span className="text-[10px] opacity-70">{items.length}</span>
                    </button>
                  ) : null}
                  {collapsed ? null : (
                    <div className="nc-stagger grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {items.map((connection) => (
                        <ContextMenu key={connection.id}>
                          <ContextMenuTrigger asChild>
                            <div className="soft-card elevate group relative flex h-[68px] items-center gap-3 rounded-xl px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
                                aria-label={`${t('databases.open')} ${connection.label}`}
                                onClick={() => open(connection)}
                              >
                                <span className="relative shrink-0">
                                  <VaultEntityIcon
                                    className={KIND_ICON_CLASS[connection.kind]}
                                    title={t(`databases.kind.${connection.kind}`)}
                                    icon={<Database size={18} />}
                                  />
                                  {connection.colorTag && connection.colorTag !== 'none' ? (
                                    <span
                                      className={cn(
                                        'absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background',
                                        COLOR_TAG_CLASS[connection.colorTag],
                                      )}
                                    />
                                  ) : null}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="truncate text-sm font-semibold">{connection.label}</span>
                                    <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {t(`databases.kind.${connection.kind}`)}
                                    </span>
                                  </span>
                                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                    {databaseDisplayTarget(connection)}
                                  </span>
                                </span>
                              </button>
                              <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label={t('databases.edit')}
                                  title={t('databases.edit')}
                                  onClick={() => openEdit(connection)}
                                >
                                  <Pencil size={14} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label={t('databases.clone')}
                                  title={t('databases.clone')}
                                  onClick={() => clone(connection)}
                                >
                                  <Copy size={14} />
                                </Button>
                              </div>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onClick={() => open(connection)}>
                              <Play size={14} className="mr-2" />
                              {t('databases.open')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => openEdit(connection)}>
                              <Pencil size={14} className="mr-2" />
                              {t('databases.edit')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => clone(connection)}>
                              <Copy size={14} className="mr-2" />
                              {t('databases.clone')}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() => setPendingDelete(connection)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 size={14} className="mr-2" />
                              {t('databases.delete')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
      </div>

      <DatabaseConnectionDialog
        open={dialogOpen}
        connection={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSave={save}
        sshHosts={sshHosts}
        onTestConnection={onTestConnection}
        jdbcDrivers={jdbcDrivers}
        existingGroups={[...new Set(dbConnections.map((entry) => entry.group?.trim() ?? '').filter(Boolean))]}
      />

      {onUpdateJdbcDrivers ? (
        <JdbcDriversDialog
          open={driversOpen}
          onOpenChange={setDriversOpen}
          drivers={jdbcDrivers}
          onUpdateDrivers={onUpdateJdbcDrivers}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t('databases.deleteTitle')}
        message={t('databases.deleteDescription', { label: pendingDelete?.label ?? '' })}
        confirmLabel={t('databases.delete')}
        destructive
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete);
        }}
      />
    </div>
  );
};
