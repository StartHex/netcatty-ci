/**
 * SQL autocompletion entries for the database workbench editor.
 *
 * Pure: the caller feeds whatever metadata it already has (schema tables,
 * the columns of the table currently shown in the structure panel, and the
 * columns of the last result set) and gets a deduplicated, ordered list back.
 */

export type SqlCompletionKind = 'table' | 'view' | 'column' | 'keyword';

export interface SqlCompletionEntry {
  label: string;
  kind: SqlCompletionKind;
  detail?: string;
}

export interface SqlCompletionTable {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

export interface SqlCompletionColumn {
  name: string;
  type?: string;
}

const SQL_KEYWORDS = [
  'select',
  'from',
  'where',
  'group by',
  'order by',
  'having',
  'limit',
  'offset',
  'join',
  'left join',
  'right join',
  'inner join',
  'full join',
  'cross join',
  'on',
  'insert into',
  'values',
  'update',
  'set',
  'delete from',
  'create table',
  'alter table',
  'drop table',
  'truncate table',
  'create index',
  'union',
  'union all',
  'distinct',
  'as',
  'and',
  'or',
  'not',
  'is null',
  'is not null',
  'in',
  'like',
  'between',
  'exists',
  'case',
  'when',
  'then',
  'else',
  'end',
  'count(*)',
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'coalesce',
  'cast',
  'with',
  'begin',
  'commit',
  'rollback',
];

export function sqlCompletionKeywords(): string[] {
  return [...SQL_KEYWORDS];
}

export interface BuildSqlCompletionInput {
  tables?: SqlCompletionTable[];
  /** Columns of the table currently opened in the structure panel. */
  columns?: SqlCompletionColumn[];
  /** Column names of the last result set (covers aliases / joins). */
  resultColumns?: SqlCompletionColumn[];
}

const NAME_COLLATOR = new Intl.Collator();

export function buildSqlCompletionEntries({
  tables = [],
  columns = [],
  resultColumns = [],
}: BuildSqlCompletionInput): SqlCompletionEntry[] {
  const entries: SqlCompletionEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: SqlCompletionEntry) => {
    // Table names and column names may legitimately collide (e.g. `id`), but
    // kind is part of the identity so both stay available.
    const key = `${entry.kind}:${entry.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  // One shared collator: String#localeCompare re-resolves the locale for every
  // comparison and is an order of magnitude slower on thousands of names.
  const sortedTables = [...tables].sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
  for (const table of sortedTables) {
    push({
      label: table.name,
      kind: table.type === 'view' ? 'view' : 'table',
      detail: table.schema ? `${table.schema}.${table.name}` : table.name,
    });
  }

  // Merge structure and result columns into one alphabetical list. Structure
  // columns win on conflict because they carry the declared type.
  const columnByLabel = new Map<string, SqlCompletionEntry>();
  const addColumn = (column: SqlCompletionColumn, source: string) => {
    if (columnByLabel.has(column.name)) return;
    columnByLabel.set(column.name, {
      label: column.name,
      kind: 'column',
      detail: column.type ? `${column.type} · ${source}` : source,
    });
  };
  for (const column of columns) addColumn(column, 'column');
  for (const column of resultColumns) addColumn(column, 'result');
  for (const entry of [...columnByLabel.values()].sort((a, b) => NAME_COLLATOR.compare(a.label, b.label))) {
    push(entry);
  }

  for (const keyword of SQL_KEYWORDS) {
    push({ label: keyword, kind: 'keyword' });
  }

  return entries;
}
