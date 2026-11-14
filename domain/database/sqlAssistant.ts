/**
 * Prompt construction for the SQL assistant that reuses the in-app AI provider
 * configuration. Kept pure so the wording and fence stripping stay testable.
 */

export type SqlAssistantMode = 'generate' | 'explain' | 'optimize';

export interface SqlAssistantRequest {
  mode: SqlAssistantMode;
  question: string;
  sql?: string;
  dialect?: string;
  schema?: string;
}

export interface SqlAssistantMessages {
  system: string;
  prompt: string;
}

const DIALECT_LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  oracle: 'Oracle',
  sqlserver: 'SQL Server',
  sqlite: 'SQLite',
  jdbc: 'the connected JDBC database',
  onhost: 'a telecom in-memory database (ProMDB / DMDB) reached through its C client library: plain single-table style SQL, unquoted identifiers',
};

export function dialectLabel(dialect: string | undefined): string {
  if (!dialect) return 'SQL';
  return DIALECT_LABELS[dialect] ?? dialect;
}

function systemPrompt(mode: SqlAssistantMode, dialect: string | undefined): string {
  const target = dialectLabel(dialect);
  if (mode === 'explain') {
    return [
      `You explain SQL written for ${target}.`,
      'Answer in the same language as the user question (Chinese question → Chinese answer).',
      'Describe the statement step by step, call out joins, filters, sorting, and any mutation risk.',
      'Be concise: plain text, short paragraphs or bullets, no full SQL repetition.',
    ].join(' ');
  }
  if (mode === 'optimize') {
    return [
      `You optimise SQL written for ${target}.`,
      'Return exactly one fenced ```sql block with the improved statement, then up to five short bullets explaining why.',
      'Never invent tables or columns that were not provided.',
    ].join(' ');
  }
  return [
    `You write SQL for ${target}.`,
    'Return exactly one fenced ```sql block with a read-only-safe statement unless the request explicitly asks to modify data.',
    'Never invent tables or columns that were not provided. Add a short note after the block only when a caveat matters.',
  ].join(' ');
}

export function buildSqlAssistantMessages(request: SqlAssistantRequest): SqlAssistantMessages {
  const question = request.question.trim();
  const sql = (request.sql ?? '').trim();
  const schema = (request.schema ?? '').trim();
  const parts: string[] = [];
  if (schema) parts.push(`Available tables and columns:\n${schema}`);
  if (sql) parts.push(`Current SQL:\n${sql}`);
  const instruction = question
    || (request.mode === 'explain' ? 'Explain this SQL.' : 'Rewrite this SQL for readability and speed.');
  parts.push(instruction);
  return { system: systemPrompt(request.mode, request.dialect), prompt: parts.join('\n\n') };
}

/** Pull a statement out of a model answer, unwrapping a single fenced block. */
export function extractSqlFromAnswer(answer: string): string {
  const trimmed = answer.trim();
  const fenced = /```(?:sql|SQL)?\s*\n([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed.replace(/^```(?:sql|SQL)?\s*/, '').replace(/```$/, '').trim();
}

export function looksLikeSqlAnswer(answer: string): boolean {
  const sql = extractSqlFromAnswer(answer);
  return /\b(select|with|insert|update|delete|create|alter|drop|merge)\b/i.test(sql);
}
