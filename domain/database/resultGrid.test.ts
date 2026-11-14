import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellMatchesQuery,
  columnsToTsv,
  compareResultCells,
  findResultMatches,
  stepResultMatchCursor,
  sortResultRows,
} from './resultGrid';

const rows = [
  ['b', 2, null],
  ['a', 10, 'x'],
  ['c', 1, 'y'],
  ['a', 2, 'z'],
];

test('compareResultCells puts NULLs last and compares numbers numerically', () => {
  assert.equal(compareResultCells(null, 'a'), 1);
  assert.equal(compareResultCells('a', null), -1);
  assert.equal(compareResultCells(null, undefined), 0);
  assert.ok(compareResultCells(2, 10) < 0);
  assert.ok(compareResultCells('2', '10') < 0);
});

test('sortResultRows is stable and keeps empty cells last in both directions', () => {
  const ascending = sortResultRows(rows, { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(ascending, [1, 3, 0, 2]);
  const descending = sortResultRows(rows, { columnIndex: 0, direction: 'desc' });
  assert.deepEqual(descending, [2, 0, 1, 3]);

  const byNumber = sortResultRows(rows, { columnIndex: 1, direction: 'asc' });
  assert.deepEqual(byNumber, [2, 0, 3, 1]);

  const nullsLast = sortResultRows(rows, { columnIndex: 2, direction: 'desc' });
  assert.deepEqual(nullsLast, [3, 2, 1, 0]);
});

test('sortResultRows without a spec keeps the original order', () => {
  assert.deepEqual(sortResultRows(rows, null), [0, 1, 2, 3]);
});

test('cellMatchesQuery is a substring test, not a fuzzy subsequence', () => {
  assert.equal(cellMatchesQuery('BalanceManagement', 'manage'), true);
  assert.equal(cellMatchesQuery('BalanceManagement', 'bmgt'), false);
  assert.equal(cellMatchesQuery('CF_DYNAMIC_MSISDN', 'sms'), false);
  assert.equal(cellMatchesQuery('BalanceManagement', 'zzz'), false);
  assert.equal(cellMatchesQuery(null, 'a'), false);
  assert.equal(cellMatchesQuery('abc', '   '), false);
});

test('findResultMatches scans all rows and honours the column filter', () => {
  const all = findResultMatches(rows, [], 'a');
  assert.deepEqual(all, [
    { rowIndex: 1, columnIndex: 0 },
    { rowIndex: 3, columnIndex: 0 },
  ]);

  const secondColumn = findResultMatches(rows, [1], '1');
  assert.deepEqual(secondColumn, [
    { rowIndex: 1, columnIndex: 1 },
    { rowIndex: 2, columnIndex: 1 },
  ]);

  assert.deepEqual(findResultMatches(rows, [], ''), []);
});

test('columnsToTsv copies the header plus the selected columns', () => {
  const columns = [{ name: 'name' }, { name: 'amount' }, { name: 'note' }];
  assert.equal(columnsToTsv(columns, rows.slice(0, 2), [0, 1]), 'name\tamount\nb\t2\na\t10');
  assert.equal(columnsToTsv(columns, rows.slice(0, 1), []), 'name\tamount\tnote\nb\t2\t');
  assert.equal(columnsToTsv(columns, rows, [0]).split('\n')[0], 'name');
});

test('stepResultMatchCursor steps and wraps while the active match is on screen', () => {
  const positions = [3, 40, 250];
  assert.equal(stepResultMatchCursor(positions, 0, 1), 1);
  assert.equal(stepResultMatchCursor(positions, 2, 1), 0);
  assert.equal(stepResultMatchCursor(positions, 0, -1), 2);
  assert.equal(stepResultMatchCursor([], 0, 1), 0);
});

test('stepResultMatchCursor continues from the page the user paged to', () => {
  // 100 rows per page: matches on pages 1, 1, 3 and 6.
  const positions = [3, 40, 250, 590];
  // Looking at page 2 (rows 100-199): next is the match on page 3, previous the last one on page 1.
  assert.equal(stepResultMatchCursor(positions, 0, 1, { start: 100, end: 200 }), 2);
  assert.equal(stepResultMatchCursor(positions, 3, -1, { start: 100, end: 200 }), 1);
  // Past the last match: next wraps to the first, previous lands on the last.
  assert.equal(stepResultMatchCursor(positions, 0, 1, { start: 600, end: 700 }), 0);
  assert.equal(stepResultMatchCursor(positions, 0, -1, { start: 600, end: 700 }), 3);
  // A single match elsewhere is still reachable (the cursor value does not change).
  assert.equal(stepResultMatchCursor([590], 0, 1, { start: 0, end: 100 }), 0);
});
