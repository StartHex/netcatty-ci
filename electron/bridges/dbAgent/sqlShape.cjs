"use strict";

/**
 * Text-level helpers for database client libraries that report less than a
 * driver normally does: DSCI returns rows without column names, and the
 * in-memory databases describe a table as the DDL that created it.
 */

const LEADING_NOISE = /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)*/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$#]*$/;

/** Splits on `separator` outside quotes and parentheses. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && char === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Index of a whole word at paren depth 0 outside quotes, or -1. */
function findTopLevelWord(text, word, from = 0) {
  const lower = text.toLowerCase();
  let depth = 0;
  let quote = null;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth !== 0 || !lower.startsWith(word, index)) continue;
    const before = index === 0 ? " " : text[index - 1];
    const after = text[index + word.length] ?? " ";
    if (/[\s)]/.test(before) && /[\s(]/.test(after)) return index;
  }
  return -1;
}

function unquote(name) {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && /^["`]/.test(trimmed) && trimmed.endsWith(trimmed[0])) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function columnLabel(item) {
  const text = item.trim();
  const alias = /\s+as\s+("[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$#]*)$/i.exec(text);
  if (alias) return unquote(alias[1]);
  const words = splitTopLevel(text, " ").filter(Boolean);
  if (words.length >= 2) {
    const last = unquote(words[words.length - 1]);
    const previous = words[words.length - 2];
    // `price * 2 total`: an identifier after a complete expression is an alias.
    if (IDENTIFIER.test(last) && !/[-+*/|,(]$/.test(previous) && !/^(and|or|not|then|else|end|when|is|null|like|in)$/i.test(last)) {
      return last;
    }
  }
  if (/^[A-Za-z_][A-Za-z0-9_$#.]*$/.test(text)) return text.slice(text.lastIndexOf(".") + 1);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/**
 * Column labels of a SELECT, read from its text.
 *
 * Returns `{ names }` when every item can be labelled, `{ starTable }` for
 * a plain `select * from one_table`, and null when the text does not say.
 */
function deriveSelectColumns(sql) {
  const body = String(sql ?? "").replace(LEADING_NOISE, "").replace(/;\s*$/, "");
  const head = /^select\s+(?:distinct\s+|all\s+)?/i.exec(body);
  if (!head) return null;
  const fromAt = findTopLevelWord(body, "from", head[0].length - 1);
  if (fromAt < 0) return null;
  const list = body.slice(head[0].length, fromAt).trim();
  if (!list) return null;
  const items = splitTopLevel(list, ",").map((item) => item.trim());
  if (items.length === 1 && items[0] === "*") {
    const rest = body.slice(fromAt + 4).trim();
    const table = /^([A-Za-z_"`][A-Za-z0-9_$#."`]*)/.exec(rest);
    const tail = table ? rest.slice(table[0].length).trim() : "";
    // A join or a second table makes `*` more than this table's columns.
    if (!table || /^,|^(?:inner|left|right|full|cross|natural)?\s*join\b/i.test(tail)) return null;
    if (/^[A-Za-z_][A-Za-z0-9_$#]*\s*,|^[A-Za-z_][A-Za-z0-9_$#]*\s+(?:inner|left|right|full|cross|natural|join)\b/i.test(tail)) {
      return null;
    }
    return { starTable: table[1].split(".").map(unquote).join(".") };
  }
  if (items.some((item) => item === "*" || /\.\*$/.test(item) || item === "")) return null;
  return { names: items.map(columnLabel) };
}

/**
 * Columns from the DDL an in-memory database prints for `desc table`:
 *
 *   CREATE TABLE APP.T
 *   (
 *   ID INT NOT NULL,
 *   NAME VARCHAR(32),
 *   PRIMARY KEY(ID)
 *   );
 */
function parseDescribeOutput(lines) {
  const text = lines.join("\n");
  const start = /create\s+table[^\n(]*\(?/i.exec(text);
  if (!start) return [];
  let body = text.slice(start.index + start[0].length);
  if (!start[0].endsWith("(")) {
    const open = body.indexOf("(");
    if (open < 0) return [];
    body = body.slice(open + 1);
  }
  // Up to the parenthesis that closes the column list.
  let depth = 0;
  let end = body.length;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "(") depth += 1;
    else if (body[index] === ")") {
      if (depth === 0) {
        end = index;
        break;
      }
      depth -= 1;
    }
  }
  const columns = [];
  const primary = new Set();
  for (const raw of splitTopLevel(body.slice(0, end), ",")) {
    const item = raw.replace(/\s+/g, " ").trim();
    if (!item) continue;
    const key = /^primary\s+key\s*\(([^)]*)\)/i.exec(item);
    if (key) {
      for (const name of key[1].split(",")) primary.add(unquote(name).toUpperCase());
      continue;
    }
    if (/^(constraint|unique|index|key|foreign|check)\b/i.test(item)) continue;
    const column = /^("[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$#]*)\s+(.+)$/.exec(item);
    if (!column) continue;
    const rest = column[2];
    const type = rest.replace(/\s+(not\s+null|null|default\b.*|primary\s+key.*)$/i, "").replace(/\s+(not\s+null|null)\b.*$/i, "").trim();
    columns.push({
      name: unquote(column[1]),
      type,
      nullable: !/\bnot\s+null\b/i.test(rest),
      primaryKey: /\bprimary\s+key\b/i.test(rest),
    });
  }
  for (const column of columns) {
    if (primary.has(column.name.toUpperCase())) column.primaryKey = true;
  }
  return columns;
}

/** A value inside a single-quoted SQL literal. */
function quoteLiteral(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

module.exports = {
  deriveSelectColumns,
  parseDescribeOutput,
  quoteLiteral,
  splitTopLevel,
};
