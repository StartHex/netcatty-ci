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
import { VaultHeaderSearch, VaultPageHeader, vaultHeaderSecondaryButtonClass } from '../vault/VaultPageHeader';
import type { DbTestConnectionResult } from '../../domain/models';
import { DatabaseConnectionDialog } from './DatabaseConnectionDialog';
import { JdbcDriversDialog } from './JdbcDriversDialog';
import type { DatabaseColorTag, JdbcDriver } from '../../domain/models';
import { mergeImported } from '../../domain/database/connectionTransfer';
import { useDatabaseConfigTransfer } from '../../application/state/useDatabaseConfigTransfer';
import { toast } from '../ui/toast';

const KIND_ACCENT: Record<DatabaseKind, string> = {
  postgresql: 'text-sky-500',
  mysql: 'text-amber-500',
  mariadb: 'text-orange-500',
  oracle: 'text-red-500',
  sqlserver: 'text-blue-500',
  sqlite: 'text-emerald-500',
  jdbc: 'text-violet-500',
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
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h2 className="truncate text-sm font-semibold">{t('databases.title')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('databases.count', { count: String(dbConnections.length) })}
          </span>
        </div>
        <VaultHeaderSearch
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('databases.search.placeholder')}
          className="w-[240px]"
        />
        <Button
          className={cn(vaultHeaderSecondaryButtonClass, 'h-9')}
          disabled={transferring || dbConnections.length === 0}
          onClick={() => void exportConfig()}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {t('databases.transfer.export')}
        </Button>
        <Button
          className={cn(vaultHeaderSecondaryButtonClass, 'h-9')}
          disabled={transferring}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {t('databases.transfer.import')}
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
        {onUpdateJdbcDrivers ? (
          <Button
            className={cn(vaultHeaderSecondaryButtonClass, 'h-9')}
            onClick={() => setDriversOpen(true)}
          >
            <PlugZap className="mr-1.5 h-3.5 w-3.5" />
            {t('databases.drivers.open')}
          </Button>
        ) : null}
        <Button className={cn(vaultHeaderSecondaryButtonClass, 'h-9')} onClick={openCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('databases.new')}
        </Button>
      </VaultPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {connections.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary">
              <Database className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{t('databases.empty.title')}</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {t('databases.empty.description')}
              </p>
            </div>
            <Button onClick={openCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
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
                      className="mb-2 flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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
                    <div className="nc-stagger grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((connection) => (
              <div
                key={connection.id}
                className="nc-card-hover group flex flex-col gap-3 rounded-lg border border-border/60 bg-card p-3 hover:border-border"
              >
                <div className="flex items-start gap-2">
                  <span className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    <Database className={cn('h-4 w-4 shrink-0', KIND_ACCENT[connection.kind])} />
                    {connection.colorTag && connection.colorTag !== 'none' ? (
                      <span
                        className={cn(
                          'absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full ring-1 ring-card',
                          COLOR_TAG_CLASS[connection.colorTag],
                        )}
                      />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{connection.label}</p>
                      <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t(`databases.kind.${connection.kind}`)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {databaseDisplayTarget(connection)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" className="h-7 flex-1 text-xs" onClick={() => open(connection)}>
                    <Play className="mr-1 h-3 w-3" />
                    {t('databases.open')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    title={t('databases.edit')}
                    onClick={() => openEdit(connection)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    title={t('databases.clone')}
                    onClick={() => clone(connection)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    title={t('databases.delete')}
                    onClick={() => setPendingDelete(connection)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
