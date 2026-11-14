/**
 * In-place table editing helpers: work out which single table a SELECT reads
 * from, then build the UPDATE/DELETE statements that address one row by its
 * primary key. All pure so the workbench can be tested without a database.
 */

import type { DatabaseKind } from '../models/database';
import type { DbCellValue } from '../models/database';

export interface EditTarget {
  schema?: string;
  table: string;
}

export interface EditableColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
}

const NUMERIC_TYPE_RE = /(int|serial|decimal|numeric|float|double|real|money|number)/i;
const NUMERIC_VALUE_RE = /^-?\d+(?:\.\d+)?$/;

const IDENT_PART = '(?:"?[A-Za-z_][\\w$#]*"?|`[^`]+`)';

/**
 * Only plain `select ... from <table>` statements are editable. Joins,
 * sub-selects and unions would make the row identity ambiguous.
 */
export function parseSingleTableQuery(sql: string): EditTarget | null {
  const statement = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '');
  if (!/^select\b/i.test(statement)) return null;
  if (/\b(join|union|intersect|except)\b/i.test(statement)) return null;
  const match = new RegExp(`\\bfrom\\s+(${IDENT_PART}(?:\\s*\\.\\s*${IDENT_PART})?)([\\s\\S]*)$`, 'i').exec(statement);
  if (!match) return null;
  const rest = match[2] ?? '';
  const fromTail = rest.split(/\b(where|group|order|having|limit|offset|fetch)\b/i)[0] ?? '';
  if (fromTail.includes(',')) return null;
  const parts = match[1].split('.').map((part) => part.trim().replace(/^["`]|["`]$/g, ''));
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { table: parts[0] };
}

export function quoteIdentifier(name: string, kind: DatabaseKind): string {
  // The host client libraries route statements by their plain text and their
  // in-memory engines do not take quoted names: a plain name stays as it is.
  // Anything else is still quoted - a statement the engine may refuse is
  // better than one that means something else.
  if (kind === 'onhost' && /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name)) return name;
  if (kind === 'mysql' || kind === 'mariadb' || kind === 'sqlite') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedTable(target: EditTarget, kind: DatabaseKind): string {
  const table = quoteIdentifier(target.table, kind);
  return target.schema ? `${quoteIdentifier(target.schema, kind)}.${table}` : table;
}

export function sqlLiteral(value: DbCellValue, type: string | undefined, kind: DatabaseKind): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? (kind === 'sqlite' ? '1' : 'TRUE') : kind === 'sqlite' ? '0' : 'FALSE';
  if (Array.isArray(value) || typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  const text = String(value);
  if (type && NUMERIC_TYPE_RE.test(type) && NUMERIC_VALUE_RE.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function primaryKeyColumns(columns: EditableColumn[]): EditableColumn[] {
  return columns.filter((column) => column.primaryKey);
}

export function canEditRows(columns: EditableColumn[]): boolean {
  return primaryKeyColumns(columns).length > 0;
}

export function rowKeyValues(
  columns: EditableColumn[],
  row: DbCellValue[],
  resultColumns: string[],
): Array<{ column: EditableColumn; value: DbCellValue }> | null {
  const keys = primaryKeyColumns(columns);
  if (keys.length === 0) return null;
  const values: Array<{ column: EditableColumn; value: DbCellValue }> = [];
  for (const key of keys) {
    const index = resultColumns.findIndex((name) => name.toLowerCase() === key.name.toLowerCase());
    if (index < 0) return null;
    values.push({ column: key, value: row[index] ?? null });
  }
  return values;
}

export function buildUpdateStatement(options: {
  target: EditTarget;
  kind: DatabaseKind;
  columns: EditableColumn[];
  resultColumns: string[];
  row: DbCellValue[];
  column: string;
  value: DbCellValue;
}): string | null {
  const { target, kind, columns, resultColumns, row, column, value } = options;
  const keys = rowKeyValues(columns, row, resultColumns);
  if (!keys) return null;
  const columnType = columns.find((entry) => entry.name.toLowerCase() === column.toLowerCase())?.type;
  const where = keys
    .map(({ column: key, value: keyValue }) =>
      keyValue === null || keyValue === undefined
        ? `${quoteIdentifier(key.name, kind)} IS NULL`
        : `${quoteIdentifier(key.name, kind)} = ${sqlLiteral(keyValue, key.type, kind)}`,
    )
    .join(' AND ');
  return `UPDATE ${qualifiedTable(target, kind)} SET ${quoteIdentifier(column, kind)} = ${sqlLiteral(
    value,
    columnType,
    kind,
  )} WHERE ${where}`;
}

export function buildDeleteStatement(options: {
  target: EditTarget;
  kind: DatabaseKind;
  columns: EditableColumn[];
  resultColumns: string[];
  row: DbCellValue[];
}): string | null {
  const { target, kind, columns, resultColumns, row } = options;
  const keys = rowKeyValues(columns, row, resultColumns);
  if (!keys) return null;
  const where = keys
    .map(({ column: key, value: keyValue }) =>
      keyValue === null || keyValue === undefined
        ? `${quoteIdentifier(key.name, kind)} IS NULL`
        : `${quoteIdentifier(key.name, kind)} = ${sqlLiteral(keyValue, key.type, kind)}`,
    )
    .join(' AND ');
  return `DELETE FROM ${qualifiedTable(target, kind)} WHERE ${where}`;
}
