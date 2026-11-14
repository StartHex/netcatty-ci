import type { DatabaseKind } from '../models';

/** Client charsets the workbench offers for MySQL/MariaDB and JDBC connections. */
export const DATABASE_ENCODINGS = [
  'utf8mb4',
  'utf8',
  'gbk',
  'gb18030',
  'big5',
  'latin1',
] as const;

export type DatabaseEncoding = (typeof DATABASE_ENCODINGS)[number];

/**
 * Only drivers with a per-connection charset negotiate text encoding: MySQL
 * maps it to the connection charset, JDBC to the driver `characterEncoding`
 * property. Postgres/MSSQL/Oracle/SQLite hand back UTF-8 (or NLS-decoded)
 * strings and have no client-side switch.
 */
export function supportsClientEncoding(kind: DatabaseKind): boolean {
  return kind === 'mysql' || kind === 'mariadb' || kind === 'jdbc' || kind === 'onhost';
}

/**
 * What the on-host driver does when no encoding is chosen: it goes by the
 * host's locale and falls back from UTF-8 to GB18030 for text that is not
 * valid UTF-8.
 */
export const ON_HOST_AUTO_ENCODING = 'auto';

/** The charsets offered for a kind (the on-host driver has no MySQL names). */
export function databaseEncodingChoices(kind: DatabaseKind): readonly string[] {
  if (kind === 'onhost') return ['utf8', 'gbk', 'gb18030', 'big5', 'latin1'];
  return DATABASE_ENCODINGS;
}

/** Encoding to show as active; undefined means "driver default". */
export function currentDatabaseEncoding(
  kind: DatabaseKind,
  explicit?: string,
): string | null {
  if (!supportsClientEncoding(kind)) return null;
  if (explicit && explicit.trim()) return explicit.trim();
  return kind === 'onhost' ? ON_HOST_AUTO_ENCODING : 'utf8mb4';
}
