/**
 * The database connection form as data: what the fields hold while they are
 * being edited, and how that maps to a saved connection and back. Kept apart
 * from the dialog so the mapping can be reasoned about (and tested) without
 * rendering anything.
 */

import {
  DATABASE_DEFAULT_PORTS,
  databaseEffectivePort,
  sanitizeDatabaseConnection,
  type DatabaseColorTag,
  type DatabaseConnection,
  type DatabaseKind,
  type DatabaseSslMode,
  type JdbcDriver,
} from '../models/database';
import { ON_HOST_AUTO_ENCODING, supportsClientEncoding } from './encoding';
import {
  EMPTY_ON_HOST_FORM,
  onHostFormFromSettings,
  onHostSettingsFromForm,
  type OnHostFormValue,
} from './onHostForm';

export interface DatabaseConnectionFormState {
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

export const EMPTY_DATABASE_CONNECTION_FORM: DatabaseConnectionFormState = {
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

export function formFromConnection(connection: DatabaseConnection): DatabaseConnectionFormState {
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

/** Whether the kind logs in with an account typed into the form. */
export function formUsesAccount(form: DatabaseConnectionFormState): boolean {
  if (form.kind === 'sqlite') return false;
  // db.cfg mode logs in with what the host's own configuration says.
  return !(form.kind === 'onhost' && form.onHost.mode === 'config');
}

/**
 * The connection a filled-in form describes. `base` is what is being edited
 * (its identity, saved queries, order) or the identity of a new connection.
 * Fields that belong to another kind are dropped, so switching the kind of an
 * existing connection does not carry the old kind's settings along.
 */
export function connectionFromForm(
  form: DatabaseConnectionFormState,
  base: Partial<DatabaseConnection> & { id: string },
  registeredDriver?: JdbcDriver,
): DatabaseConnection {
  const isSqlite = form.kind === 'sqlite';
  const isJdbc = form.kind === 'jdbc';
  const isOnHost = form.kind === 'onhost';
  const usesAccount = formUsesAccount(form);
  // The on-host driver is addressed by its SSH host, not by host and port.
  const hasEndpoint = !isSqlite && !isOnHost;
  return sanitizeDatabaseConnection({
    ...base,
    label: form.label.trim(),
    kind: form.kind,
    host: hasEndpoint ? form.host.trim() : undefined,
    port: hasEndpoint ? Number(form.port) || undefined : undefined,
    database: hasEndpoint ? form.database.trim() || undefined : undefined,
    username: usesAccount ? form.username.trim() || undefined : undefined,
    password: usesAccount && form.savePassword ? form.password : undefined,
    savePassword: form.savePassword,
    readOnly: form.readOnly,
    sslMode: hasEndpoint ? form.sslMode : undefined,
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
    clientEncoding: supportsClientEncoding(form.kind) ? form.clientEncoding || undefined : undefined,
    onHost: isOnHost ? onHostSettingsFromForm(form.onHost) : undefined,
    group: form.group.trim() || undefined,
    colorTag: form.colorTag === 'none' ? undefined : form.colorTag,
  });
}
