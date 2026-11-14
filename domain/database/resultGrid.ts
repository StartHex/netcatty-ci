/**
 * Pure helpers behind the result grid: cross-page sorting, fuzzy search and
 * multi-column copy. Kept free of DOM so they can be unit tested from Node.
 *
 * The grid shows one page of rows at a time but sorting and search always run
 * over the whole fetched result, which is what makes both features work across
 * page boundaries.
 */

import type { DbCellValue } from '../models/database';

export type ResultSortDirection = 'asc' | 'desc';

export interface ResultSort {
  /** Index into `result.columns`. */
  columnIndex: number;
  direction: ResultSortDirection;
}

export interface ResultMatch {
  /** Row index in the unsorted result. */
  rowIndex: number;
  /** Column index of the matching cell. */
  columnIndex: number;
}

function isNumericCell(value: DbCellValue): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Cell comparison used by sorting: numbers numerically, NULL/undefined last. */
export function compareResultCells(left: DbCellValue, right: DbCellValue): number {
  const leftEmpty = left === null || left === undefined;
  const rightEmpty = right === null || right === undefined;
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;

  if (isNumericCell(left) && isNumericCell(right)) return Number(left) - Number(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Row indices ordered by one column. The sort is stable: rows that compare equal
 * keep their original order, so paging and editing stay predictable.
 *
 * Empty cells always sort last, in both directions — that matches how database
 * clients usually display NULLs and keeps the "interesting" rows on top.
 */
export function sortResultRows(
  rows: readonly DbCellValue[][],
  sort: ResultSort | null | undefined,
): number[] {
  const indices = rows.map((_, index) => index);
  if (!sort || !Number.isInteger(sort.columnIndex) || sort.columnIndex < 0) return indices;
  const { columnIndex, direction } = sort;
  const sign = direction === 'desc' ? -1 : 1;
  return indices.sort((leftIndex, rightIndex) => {
    const left = rows[leftIndex]?.[columnIndex] ?? null;
    const right = rows[rightIndex]?.[columnIndex] ?? null;
    const leftEmpty = left === null || left === undefined;
    const rightEmpty = right === null || right === undefined;
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    const compared = compareResultCells(left, right);
    if (compared !== 0) return compared * sign;
    return leftIndex - rightIndex;
  });
}

/**
 * Case-insensitive substring match for result cells.
 *
 * This used to fall back to an in-order subsequence match so that `bmg`
 * matched `BalanceManagement`, but that also made `sms` match unrelated values
 * such as `CF_DYNAMIC_MSISDN`. Filtering means "contains this", so only the
 * contiguous substring counts now.
 */
export function cellMatchesQuery(value: DbCellValue, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  if (value === null || value === undefined) return false;
  return String(value).toLowerCase().includes(needle);
}

/**
 * Every cell matching `query` across the fetched rows, in row-major order.
 * `columnIndexes` narrows the search to the selected columns; an empty list
 * means "all columns".
 */
export function findResultMatches(
  rows: readonly DbCellValue[][],
  columnIndexes: readonly number[],
  query: string,
): ResultMatch[] {
  const needle = query.trim();
  if (!needle) return [];
  const matches: ResultMatch[] = [];
  rows.forEach((row, rowIndex) => {
    const targets = columnIndexes.length > 0
      ? columnIndexes
      : row.map((_, columnIndex) => columnIndex);
    targets.forEach((columnIndex) => {
      if (cellMatchesQuery(row[columnIndex] ?? null, needle)) {
        matches.push({ rowIndex, columnIndex });
      }
    });
  });
  return matches;
}

/**
 * TSV of the selected columns (header included). Spreadsheet apps and terminals
 * both paste this correctly, which is what "copy column" is for.
 */
export function columnsToTsv(
  columns: readonly { name: string }[],
  rows: readonly DbCellValue[][],
  columnIndexes: readonly number[],
): string {
  const targets = columnIndexes.length > 0
    ? [...columnIndexes]
    : columns.map((_, index) => index);
  if (targets.length === 0) return '';
  const escape = (value: DbCellValue): string => {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  };
  const header = targets.map((index) => escape(columns[index]?.name ?? `column_${index + 1}`)).join('\t');
  const body = rows.map((row) => targets.map((index) => escape(row[index] ?? null)).join('\t'));
  return [header, ...body].join('\n');
}

/** Single cell text, used by "copy cell" and by the search highlight. */
export function cellToText(value: DbCellValue): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Picks the match the "previous / next" buttons should land on.
 *
 * `positions[i]` is the display position (row number in the current sort
 * order) of match `i`, ascending. Normally the cursor just steps and wraps.
 * When the user has paged away from the active match (`page` is given), the
 * step is taken relative to the page they are looking at instead: "next" goes
 * to the first match on or after that page, "previous" to the last match on or
 * before it — so navigation always continues from what is on screen and
 * always crosses pages.
 */
export function stepResultMatchCursor(
  positions: readonly number[],
  current: number,
  delta: 1 | -1,
  page?: { start: number; end: number } | null,
): number {
  const total = positions.length;
  if (total === 0) return 0;
  if (!page) return (((current + delta) % total) + total) % total;
  if (delta > 0) {
    const index = positions.findIndex((position) => position >= page.start);
    return index >= 0 ? index : 0;
  }
  for (let index = total - 1; index >= 0; index -= 1) {
    if (positions[index] < page.end) return index;
  }
  return total - 1;
}
