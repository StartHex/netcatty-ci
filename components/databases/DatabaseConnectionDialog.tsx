/**
 * Create/edit form for a database connection. Kept as a dialog so the Vault
 * section list stays a plain list; the form owns no persistence.
 */

import { CheckCircle2, Eye, EyeOff, FolderOpen, Loader2, Plus, TestTube2, X, XCircle } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  DATABASE_DEFAULT_PORTS,
  databaseDisplayTarget,
  databaseEffectivePort,
  sanitizeDatabaseConnection,
  type DatabaseConnection,
  type DatabaseKind,
  type JdbcDriver,
  type DatabaseColorTag,
  type DatabaseSslMode,
} from '../../domain/models';
import { cn } from '../../lib/utils';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { detectJavaRuntime, readJdbcDriverClasses } from '@/infrastructure/services/databaseService';
import { describeDatabaseConnectFailure } from '../../application/state/databaseErrorMessages';
import type { DbTestConnectionResult } from '../../domain/models';
import {
  JDBC_PRESETS,
  applyJdbcPresetTemplate,
  findJdbcPreset,
} from '../../domain/database/jdbcPresets';
import {
  ON_HOST_AUTO_ENCODING,
  databaseEncodingChoices,
  supportsClientEncoding,
} from '../../domain/database/encoding';
import {
  EMPTY_ON_HOST_FORM,
  onHostFormFromSettings,
  onHostFormProblem,
  onHostSettingsFromForm,
  type OnHostFormValue,
} from '../../domain/database/onHostForm';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { OnHostConnectionFields } from './OnHostConnectionFields';

const KINDS: DatabaseKind[] = ['postgresql', 'mysql', 'mariadb', 'oracle', 'sqlserver', 'sqlite', 'jdbc', 'onhost'];
const SSL_MODES: DatabaseSslMode[] = ['disable', 'require', 'verify-ca', 'verify-full'];

const COLOR_TAGS: DatabaseColorTag[] = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

const COLOR_CLASS: Record<Exclude<DatabaseColorTag, 'none'>, string> = {
  red: 'border-transparent bg-red-500',
  orange: 'border-transparent bg-orange-500',
  yellow: 'border-transparent bg-amber-400',
  green: 'border-transparent bg-emerald-500',
  blue: 'border-transparent bg-sky-500',
  purple: 'border-transparent bg-violet-500',
};

interface FormState {
  label: string;
  kind: DatabaseKind;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  savePassword: boolean;
  readOnly: boolean;
  sslMode: DatabaseSslMode;
  initSql: string;
  sqlitePath: string;
  inMemory: boolean;
  sshHostId: string;
  jdbcUrl: string;
  jdbcDriverClass: string;
  jdbcDriverPaths: string[];
  jdbcDriverId: string;
  javaPath: string;
  jdbcPresetId: string;
  clientEncoding: string;
  group: string;
  colorTag: DatabaseColorTag;
  /** The on-host kind's own fields; kept while another kind is selected. */
  onHost: OnHostFormValue;
}

const EMPTY_FORM: FormState = {
  label: '',
  kind: 'postgresql',
  host: '127.0.0.1',
  port: String(DATABASE_DEFAULT_PORTS.postgresql),
  database: '',
  username: '',
  password: '',
  savePassword: true,
  readOnly: false,
  sslMode: 'disable',
  initSql: '',
  sqlitePath: '',
  inMemory: false,
  sshHostId: '',
  jdbcUrl: '',
  jdbcDriverClass: '',
  jdbcDriverPaths: [],
  jdbcDriverId: '',
  javaPath: '',
  jdbcPresetId: '',
  clientEncoding: '',
  group: '',
  colorTag: 'none',
  onHost: EMPTY_ON_HOST_FORM,
};

export function formFromConnection(connection: DatabaseConnection): FormState {
  return {
    label: connection.label,
    kind: connection.kind,
    host: connection.host ?? '127.0.0.1',
    port: String(databaseEffectivePort(connection) ?? ''),
    database: connection.database ?? '',
    username: connection.username ?? '',
    password: connection.password ?? '',
    savePassword: connection.savePassword !== false,
    readOnly: connection.readOnly === true,
    sslMode: connection.sslMode ?? 'disable',
    initSql: connection.initSql ?? '',
    sqlitePath: connection.sqlitePath ?? '',
    inMemory: connection.inMemory === true,
    sshHostId: connection.sshHostId ?? '',
    jdbcUrl: connection.jdbcUrl ?? '',
    jdbcDriverClass: connection.jdbcDriverClass ?? '',
    jdbcDriverPaths: connection.jdbcDriverPaths ?? [],
    jdbcDriverId: connection.jdbcDriverId ?? '',
    javaPath: connection.javaPath ?? '',
    jdbcPresetId: '',
    // The on-host driver's "automatic" is the form's default entry.
    clientEncoding:
      connection.kind === 'onhost' && connection.clientEncoding === ON_HOST_AUTO_ENCODING
        ? ''
        : connection.clientEncoding ?? '',
    group: connection.group ?? '',
    colorTag: connection.colorTag ?? 'none',
    onHost: onHostFormFromSettings(connection.onHost),
  };
}

/** "Testing connection… 3.2 s" — ticks on its own so the form does not re-render. */
const TestElapsed: React.FC<{ startedAt?: number; format: (seconds: string) => string; fallback: string }> = ({
  startedAt,
  format,
  fallback,
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return <>{fallback}</>;
  const elapsed = Math.max(0, now - startedAt);
  return <>{format(elapsed < 10_000 ? (elapsed / 1000).toFixed(1) : String(Math.round(elapsed / 1000)))}</>;
};

interface TestState {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
  /** What the driver or the host said, shown under the message. */
  detail?: string;
}

/**
 * Module-level draft cache: mounted dialogues unmount when Radix closes them,
 * so component state alone cannot survive an accidental dismissal.
 */
const draftCache = new Map<string, FormState>();

export interface DatabaseConnectionDialogProps {
  open: boolean;
  connection?: DatabaseConnection | null;
  /** SSH hosts that can be used as a jump box for this connection. */
  sshHosts?: { id: string; label: string }[];
  jdbcDrivers?: JdbcDriver[];
  /** Existing group names offered as datalist options. */
  existingGroups?: string[];
  onTestConnection?: (draft: DatabaseConnection) => Promise<DbTestConnectionResult>;
  onClose: () => void;
  onSave: (connection: DatabaseConnection) => void;
}

export const DatabaseConnectionDialog: React.FC<DatabaseConnectionDialogProps> = ({
  open,
  connection,
  sshHosts,
  jdbcDrivers = [],
  existingGroups = [],
  onTestConnection,
  onClose,
  onSave,
}) => {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const groupOptions = existingGroups;
  const [detectedClasses, setDetectedClasses] = useState<string[]>([]);
  const [javaInfo, setJavaInfo] = useState<{ ok: boolean; text: string } | null>(null);
  const [javaChecking, setJavaChecking] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  // Every edit (and every new test) bumps this, so a slow test that finishes
  // after the form changed cannot report on settings that are gone.
  const testSeqRef = useRef(0);
  const [testStartedAt, setTestStartedAt] = useState<number | undefined>(undefined);
  const resetTest = () => {
    testSeqRef.current += 1;
    setTest({ status: 'idle' });
    setTestStartedAt(undefined);
  };
  const [showError, setShowError] = useState(false);
  // Mask the stored password by default; the eye toggle mirrors the SSH host
  // form so both connection forms behave the same way.
  const [showPassword, setShowPassword] = useState(false);
  const draftKey = connection ? `connection:${connection.id}` : 'connection:new';

  useEffect(() => {
    if (!open) return;
    // Restore an unfinished draft: dismissing the dialog (outside click, Esc,
    // switching windows) must never throw away what the user already typed.
    setForm(draftCache.get(draftKey) ?? (connection ? formFromConnection(connection) : EMPTY_FORM));
    testSeqRef.current += 1;
    setTest({ status: 'idle' });
    setTestStartedAt(undefined);
    setShowError(false);
    setShowPassword(false);
  }, [open, connection, draftKey]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      draftCache.set(draftKey, next);
      return next;
    });
    resetTest();
  };

  const changeKind = (kind: DatabaseKind) => {
    setForm((prev) => {
      const previousDefault = String(DATABASE_DEFAULT_PORTS[prev.kind] ?? '');
      const nextDefault = String(DATABASE_DEFAULT_PORTS[kind] ?? '');
      const port =
        prev.port === previousDefault || prev.port === '' ? nextDefault : prev.port;
      const next = {
        ...prev,
        kind,
        port,
        host: kind === 'sqlite' ? prev.host : prev.host === '' ? '127.0.0.1' : prev.host,
        // Kinds offer different charsets: one the new kind does not have
        // would be saved without showing in its list.
        clientEncoding: databaseEncodingChoices(kind).includes(prev.clientEncoding) ? prev.clientEncoding : '',
      };
      draftCache.set(draftKey, next);
      return next;
    });
    resetTest();
  };

  const isSqlite = form.kind === 'sqlite';
  const isJdbc = form.kind === 'jdbc';
  const isOnHost = form.kind === 'onhost';
  // db.cfg mode logs in with what the host's own configuration says.
  const usesAccount = !isSqlite && !(isOnHost && form.onHost.mode === 'config');
  const supportsEncoding = supportsClientEncoding(form.kind);

  const registeredDriver = useMemo(
    () => jdbcDrivers.find((driver) => driver.id === form.jdbcDriverId),
    [jdbcDrivers, form.jdbcDriverId],
  );

  const draft = useMemo<DatabaseConnection>(() => {
    const base = connection ?? { id: crypto.randomUUID(), createdAt: Date.now() };
    return sanitizeDatabaseConnection({
      ...base,
      label: form.label.trim(),
      kind: form.kind,
      host: isSqlite || isOnHost ? undefined : form.host.trim(),
      port: isSqlite || isOnHost ? undefined : Number(form.port) || undefined,
      database: isSqlite || isOnHost ? undefined : form.database.trim() || undefined,
      username: usesAccount ? form.username.trim() || undefined : undefined,
      password: usesAccount && form.savePassword ? form.password : undefined,
      savePassword: form.savePassword,
      readOnly: form.readOnly,
      sslMode: isSqlite || isOnHost ? undefined : form.sslMode,
      initSql: form.initSql.trim() || undefined,
      sqlitePath: isSqlite ? form.sqlitePath.trim() : undefined,
      inMemory: isSqlite ? form.inMemory : undefined,
      sshHostId: isSqlite ? undefined : form.sshHostId || undefined,
      jdbcUrl: isJdbc ? form.jdbcUrl.trim() : undefined,
      jdbcDriverId: isJdbc ? form.jdbcDriverId || undefined : undefined,
      jdbcDriverClass: isJdbc
        ? form.jdbcDriverClass.trim() || registeredDriver?.driverClass
        : undefined,
      jdbcDriverPaths: isJdbc
        ? form.jdbcDriverPaths.length > 0
          ? form.jdbcDriverPaths
          : registeredDriver
            ? registeredDriver.jarPaths?.length
              ? registeredDriver.jarPaths
              : [registeredDriver.jarPath]
            : undefined
        : undefined,
      javaPath: isJdbc ? form.javaPath.trim() || undefined : undefined,
      clientEncoding: supportsEncoding ? form.clientEncoding || undefined : undefined,
      onHost: isOnHost ? onHostSettingsFromForm(form.onHost) : undefined,
      group: form.group.trim() || undefined,
      colorTag: form.colorTag === 'none' ? undefined : form.colorTag,
    });
  }, [connection, form, isJdbc, isOnHost, isSqlite, registeredDriver, supportsEncoding, usesAccount]);

  const labelError = !draft.label;
  const onHostProblem = isOnHost
    ? onHostFormProblem({ sshHostId: form.sshHostId, username: form.username, form: form.onHost })
    : null;
  const targetError = isSqlite
    ? !draft.inMemory && !draft.sqlitePath
    : isJdbc
      ? !draft.jdbcUrl || !/^jdbc:/.test(draft.jdbcUrl) || (draft.jdbcDriverPaths?.length ?? 0) === 0
      : isOnHost
        ? onHostProblem !== null
        : !draft.host || !draft.port || draft.port < 1 || draft.port > 65535;
  const invalid = labelError || targetError;

  const handleSave = () => {
    setShowError(true);
    if (invalid) return;
    draftCache.delete(draftKey);
    onSave(draft);
  };

  const handleTest = async () => {
    if (targetError) {
      setShowError(true);
      return;
    }
    if (!onTestConnection) return;
    testSeqRef.current += 1;
    const seq = testSeqRef.current;
    setTest({ status: 'testing' });
    setTestStartedAt(Date.now());
    let result: DbTestConnectionResult;
    try {
      result = await onTestConnection(draft);
    } catch (error) {
      result = { ok: false, durationMs: 0, error: error instanceof Error ? error.message : String(error) };
    }
    if (seq !== testSeqRef.current) return;
    setTestStartedAt(undefined);
    if (result.ok) {
      setTest({
        status: 'ok',
        message: t('databases.testOk', {
          version: result.serverVersion ?? '',
          ms: String(result.durationMs ?? 0),
        }),
      });
    } else {
      setTest({
        status: 'error',
        message: describeDatabaseConnectFailure(result, t, t('databases.testFailed')),
        detail: result.errorDetail,
      });
    }
  };

  const applyPreset = (presetId: string) => {
    const preset = findJdbcPreset(presetId);
    if (!preset) {
      update('jdbcPresetId', presetId);
      return;
    }
    setForm((prev) => {
      const next = {
        ...prev,
        jdbcPresetId: presetId,
        jdbcDriverClass: preset.driverClass,
        jdbcUrl: applyJdbcPresetTemplate(preset, {
          host: prev.host || '127.0.0.1',
          port: Number(prev.port) || preset.defaultPort,
          database: prev.database,
        }),
      };
      draftCache.set(draftKey, next);
      return next;
    });
    resetTest();
  };

  const addDriverJar = async () => {
    const selected = await netcattyBridge.get()?.selectFile?.(
      t('databases.form.jdbcDriverJars'),
      undefined,
      [{ name: 'JAR', extensions: ['jar'] }],
    );
    if (!selected) return;
    if (form.jdbcDriverPaths.includes(selected)) setDetectedClasses([]);
    if (form.jdbcDriverPaths.includes(selected)) return;
    update('jdbcDriverPaths', [...form.jdbcDriverPaths, selected]);
    const classes = await readJdbcDriverClasses(selected);
    setDetectedClasses(classes);
    if (!form.jdbcDriverClass.trim() && classes.length === 1) {
      update('jdbcDriverClass', classes[0]);
    }
  };

  const detectJava = async () => {
    setJavaChecking(true);
    try {
      const result = await detectJavaRuntime(form.javaPath.trim() || undefined);
      if (result.ok && result.path) {
        setJavaInfo({ ok: true, text: result.version ?? result.path });
        if (!form.javaPath.trim()) update('javaPath', result.path);
      } else {
        setJavaInfo({ ok: false, text: result.error ?? 'java-not-found' });
      }
    } finally {
      setJavaChecking(false);
    }
  };

  const browse = async () => {
    const selected = await netcattyBridge.get()?.selectFile?.(
      t('databases.form.sqlitePath'),
      form.sqlitePath || undefined,
      [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }],
    );
    if (selected) update('sqlitePath', selected);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className="nc-anim-pop-in flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-[640px] flex-col overflow-hidden"
        // A stray click outside must not dismiss the form: the footer holds
        // the only way to save, and small screens put it off-view.
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {connection ? t('databases.form.titleEdit') : t('databases.form.titleNew')}
          </DialogTitle>
          <DialogDescription>{t('databases.form.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto py-1 pr-1">
          <div className="grid gap-2">
            <Label htmlFor="db-label">{t('databases.form.label')}</Label>
            <Input
              id="db-label"
              value={form.label}
              placeholder={t('databases.form.labelPlaceholder')}
              onChange={(event) => update('label', event.target.value)}
            />
            {showError && labelError ? (
              <p className="text-xs text-destructive">{t('databases.form.required')}</p>
            ) : null}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="db-group">{t('databases.form.group')}</Label>
              <Input
                id="db-group"
                list="db-group-options"
                value={form.group ?? ''}
                placeholder={t('databases.form.groupPlaceholder')}
                onChange={(event) => update('group', event.target.value)}
              />
              <datalist id="db-group-options">
                {groupOptions.map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-2">
              <Label>{t('databases.form.colorTag')}</Label>
              <div className="flex items-center gap-1.5">
                {COLOR_TAGS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    className={cn(
                      'h-5 w-5 rounded-full border transition-transform',
                      color === 'none' ? 'border-border bg-background' : COLOR_CLASS[color],
                      (form.colorTag ?? 'none') === color
                        ? 'ring-2 ring-ring ring-offset-1 ring-offset-background'
                        : 'hover:scale-105',
                    )}
                    onClick={() => update('colorTag', color)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>{t('databases.form.kind')}</Label>
            <Select value={form.kind} onValueChange={(value) => changeKind(value as DatabaseKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`databases.kind.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isJdbc ? (
            <>
              <div className="grid gap-2">
                <Label>{t('databases.drivers.useRegistered')}</Label>
                <Select
                  value={form.jdbcDriverId || '__none__'}
                  onValueChange={(value) => {
                    const driver = jdbcDrivers.find((entry) => entry.id === value);
                    setForm((prev) => ({
                      ...prev,
                      jdbcDriverId: driver ? driver.id : '',
                      jdbcDriverClass: driver?.driverClass ?? prev.jdbcDriverClass,
                      jdbcDriverPaths: driver
                        ? (driver.jarPaths?.length ? driver.jarPaths : [driver.jarPath])
                        : prev.jdbcDriverPaths,
                    }));
                    resetTest();
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t('databases.drivers.useManualJars')}</SelectItem>
                    {jdbcDrivers.map((driver) => (
                      <SelectItem key={driver.id} value={driver.id}>
                        {driver.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label>{t('databases.form.jdbcPreset')}</Label>
                <Select
                  value={form.jdbcPresetId || '__custom__'}
                  onValueChange={(value) => applyPreset(value === '__custom__' ? '' : value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__custom__">{t('databases.form.jdbcPresetCustom')}</SelectItem>
                    {JDBC_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {findJdbcPreset(form.jdbcPresetId) ? (
                  <a
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                    href={findJdbcPreset(form.jdbcPresetId)!.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('databases.form.jdbcPresetDownload')}
                  </a>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="db-jdbc-url">{t('databases.form.jdbcUrl')}</Label>
                <Input
                  id="db-jdbc-url"
                  value={form.jdbcUrl}
                  placeholder={t('databases.form.jdbcUrlPlaceholder')}
                  onChange={(event) => update('jdbcUrl', event.target.value)}
                />
                {showError && targetError ? (
                  <p className="text-xs text-destructive">{t('databases.form.jdbcUrlRequired')}</p>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="db-jdbc-class">{t('databases.form.jdbcDriverClass')}</Label>
                <Input
                  id="db-jdbc-class"
                  value={form.jdbcDriverClass}
                  placeholder={t('databases.form.jdbcDriverClassPlaceholder')}
                  onChange={(event) => update('jdbcDriverClass', event.target.value)}
                />
                {detectedClasses.length ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-muted-foreground">
                      {t('databases.form.jdbcDetectedClasses')}
                    </span>
                    {detectedClasses.map((entry) => (
                      <Button
                        key={entry}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 font-mono text-[11px]"
                        onClick={() => update('jdbcDriverClass', entry)}
                      >
                        {entry}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label>{t('databases.form.jdbcDriverJars')}</Label>
                <div className="flex flex-col gap-1">
                  {form.jdbcDriverPaths.map((jarPath) => (
                    <div
                      key={jarPath}
                      className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={jarPath}>
                        {jarPath}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 w-5 p-0"
                        onClick={() =>
                          update('jdbcDriverPaths', form.jdbcDriverPaths.filter((entry) => entry !== jarPath))
                        }
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 self-start text-xs"
                    onClick={() => void addDriverJar()}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {t('databases.form.jdbcAddJar')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('databases.form.jdbcJarHint')}</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="db-java-path">{t('databases.form.javaPath')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="db-java-path"
                    value={form.javaPath}
                    placeholder={t('databases.form.javaPathPlaceholder')}
                    onChange={(event) => update('javaPath', event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    disabled={javaChecking}
                    onClick={() => void detectJava()}
                  >
                    {javaChecking ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    {t('databases.form.javaDetect')}
                  </Button>
                </div>
                {javaInfo ? (
                  <p className={javaInfo.ok ? 'text-xs text-emerald-500' : 'text-xs text-destructive'}>
                    {javaInfo.ok ? t('databases.form.javaFound').replace('{version}', javaInfo.text) : javaInfo.text}
                  </p>
                ) : null}
              </div>
            </>
          ) : isOnHost ? (
            <OnHostConnectionFields
              value={form.onHost}
              sshHostId={form.sshHostId}
              sshHosts={sshHosts ?? []}
              problem={onHostProblem}
              showError={showError}
              onChange={(patch) => update('onHost', { ...form.onHost, ...patch })}
              onHostChange={(hostId) => update('sshHostId', hostId)}
            />
          ) : isSqlite ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="db-sqlite-path">{t('databases.form.sqlitePath')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="db-sqlite-path"
                    value={form.sqlitePath}
                    disabled={form.inMemory}
                    placeholder={t('databases.form.sqlitePathPlaceholder')}
                    onChange={(event) => update('sqlitePath', event.target.value)}
                  />
                  <Button type="button" variant="outline" disabled={form.inMemory} onClick={() => void browse()}>
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    {t('databases.form.browse')}
                  </Button>
                </div>
                {showError && targetError && !form.inMemory ? (
                  <p className="text-xs text-destructive">{t('databases.form.required')}</p>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{t('databases.form.inMemory')}</p>
                  <p className="text-xs text-muted-foreground">{t('databases.form.inMemoryHint')}</p>
                </div>
                <Switch checked={form.inMemory} onCheckedChange={(checked) => update('inMemory', checked)} />
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="db-host">{t('databases.form.host')}</Label>
                  <Input
                    id="db-host"
                    value={form.host}
                    placeholder="127.0.0.1"
                    onChange={(event) => update('host', event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="db-port">{t('databases.form.port')}</Label>
                  <Input
                    id="db-port"
                    value={form.port}
                    inputMode="numeric"
                    onChange={(event) => update('port', event.target.value.replace(/[^0-9]/g, ''))}
                  />
                </div>
              </div>
              {showError && targetError ? (
                <p className="text-xs text-destructive">{t('databases.form.invalidTarget')}</p>
              ) : null}

              <div className="grid gap-2">
                <Label htmlFor="db-name">{t('databases.form.database')}</Label>
                <Input
                  id="db-name"
                  value={form.database}
                  placeholder={t('databases.form.databasePlaceholder')}
                  onChange={(event) => update('database', event.target.value)}
                />
              </div>





              <div className="grid gap-2">
                <Label>{t('databases.form.sslMode')}</Label>
                <Select value={form.sslMode} onValueChange={(value) => update('sslMode', value as DatabaseSslMode)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SSL_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(`databases.sslMode.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {!isSqlite ? (
            <>
              {supportsEncoding ? (
                <div className="grid gap-2">
                  <Label htmlFor="db-encoding">{t('databases.form.encoding')}</Label>
                  <Select
                    value={form.clientEncoding || '__default__'}
                    onValueChange={(value) => update('clientEncoding', value === '__default__' ? '' : value)}
                  >
                    <SelectTrigger id="db-encoding">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">
                        {isOnHost ? t('databases.onhost.encodingAuto') : t('databases.form.encodingDefault')}
                      </SelectItem>
                      {databaseEncodingChoices(form.kind).map((encoding) => (
                        <SelectItem key={encoding} value={encoding}>
                          {encoding}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {isOnHost ? t('databases.onhost.encodingHint') : t('databases.form.encodingHint')}
                  </p>
                </div>
              ) : null}
              <div className="flex items-start justify-between gap-3 rounded-md border border-border/50 px-3 py-2">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t('databases.form.readOnly')}</p>
                  <p className="text-xs text-muted-foreground">{t('databases.form.readOnlyHint')}</p>
                </div>
                <Switch
                  checked={form.readOnly}
                  onCheckedChange={(checked) => update('readOnly', checked)}
                />
              </div>
              {isOnHost ? null : (
                <div className="grid gap-2">
                  <Label>{t('databases.form.sshHost')}</Label>
                  <Select
                    value={form.sshHostId || '__direct__'}
                    onValueChange={(value) => update('sshHostId', value === '__direct__' ? '' : value)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__direct__">{t('databases.form.sshHostDirect')}</SelectItem>
                      {(sshHosts ?? []).map((host) => (
                        <SelectItem key={host.id} value={host.id}>
                          {host.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('databases.form.sshHostHint')}</p>
                </div>
              )}
            </>
          ) : null}

          {usesAccount ? (
            <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-2">
              <div>
                <p className="text-sm font-medium">{t('databases.form.savePassword')}</p>
                <p className="text-xs text-muted-foreground">{t('databases.form.savePasswordHint')}</p>
              </div>
              <Switch
                checked={form.savePassword}
                onCheckedChange={(checked) => update('savePassword', checked)}
              />
            </div>
          ) : null}

          {usesAccount ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="db-user">{t('databases.form.username')}</Label>
                <Input
                  id="db-user"
                  value={form.username}
                  autoComplete="off"
                  onChange={(event) => update('username', event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="db-password">{t('databases.form.password')}</Label>
                <div className="relative">
                  <Input
                    id="db-password"
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    autoComplete="new-password"
                    className="pr-10"
                    onChange={(event) => update('password', event.target.value)}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={
                          showPassword
                            ? t('hostDetails.password.hide')
                            : t('hostDetails.password.show')
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {showPassword
                        ? t('hostDetails.password.hide')
                        : t('hostDetails.password.show')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="db-init-sql">{t('databases.form.initSql')}</Label>
            <textarea
              id="db-init-sql"
              className="min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              value={form.initSql}
              onChange={(event) => update('initSql', event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('databases.form.initSqlHint')}</p>
          </div>

          <p className="text-xs text-muted-foreground">{databaseDisplayTarget(draft)}</p>

          {test.status !== 'idle' ? (
            <div
              key={test.status}
              role={test.status === 'error' ? 'alert' : 'status'}
              className={cn(
                'flex items-start gap-2 rounded-md border px-3 py-2 text-xs transition-colors',
                test.status === 'error'
                  ? 'nc-anim-shake border-destructive/40 bg-destructive/10 text-destructive'
                  : test.status === 'testing'
                    ? 'nc-anim-fade-in border-border/70 bg-muted/40 text-muted-foreground'
                    : 'nc-anim-pop-in border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
              )}
            >
              {test.status === 'testing' ? (
                <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : test.status === 'error' ? (
                <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
              ) : (
                <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <span className="whitespace-pre-wrap break-words">
                  {test.status === 'testing' ? (
                    <TestElapsed
                      startedAt={testStartedAt}
                      format={(seconds) => t('databases.testingElapsed', { seconds })}
                      fallback={t('databases.testing')}
                    />
                  ) : test.message}
                </span>
                {test.status === 'error' && test.detail ? (
                  <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-background/60 px-2 py-1 font-mono text-[11px] opacity-90">
                    {test.detail}
                  </pre>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-border/60 pt-3 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => void handleTest()} disabled={test.status === 'testing'}>
            {test.status === 'testing' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <TestTube2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('databases.test')}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                draftCache.delete(draftKey);
                onClose();
              }}
            >
              {t('databases.cancel')}
            </Button>
            <Button type="button" onClick={handleSave}>
              {t('databases.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
