import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeleteStatement,
  buildUpdateStatement,
  canEditRows,
  parseSingleTableQuery,
  quoteIdentifier,
  rowKeyValues,
  sqlLiteral,
} from './tableEdit';

const columns = [
  { name: 'id', type: 'int', primaryKey: true },
  { name: 'name', type: 'varchar(20)' },
];

test('parseSingleTableQuery accepts plain selects', () => {
  assert.deepEqual(parseSingleTableQuery('select * from users'), { table: 'users' });
  assert.deepEqual(parseSingleTableQuery('SELECT id FROM "public"."users" where id = 1'), {
    schema: 'public',
    table: 'users',
  });
  assert.deepEqual(parseSingleTableQuery('select * from `app`.`order`;'), { schema: 'app', table: 'order' });
});

test('parseSingleTableQuery rejects ambiguous statements', () => {
  assert.equal(parseSingleTableQuery('update users set a = 1'), null);
  assert.equal(parseSingleTableQuery('select * from a join b on a.id = b.id'), null);
  assert.equal(parseSingleTableQuery('select * from a, b'), null);
  assert.equal(parseSingleTableQuery('select 1'), null);
});

test('quoting follows the dialect', () => {
  assert.equal(quoteIdentifier('order', 'postgresql'), '"order"');
  assert.equal(quoteIdentifier('order', 'mysql'), '`order`');
  assert.equal(quoteIdentifier('we"ird', 'oracle'), '"we""ird"');
  // The on-host client libraries take plain names only; a name that is not
  // plain is still quoted rather than pasted into the statement as it is.
  assert.equal(quoteIdentifier('T_SMALL', 'onhost'), 'T_SMALL');
  assert.equal(quoteIdentifier('app_user$1', 'onhost'), 'app_user$1');
  assert.equal(quoteIdentifier('id; drop table t', 'onhost'), '"id; drop table t"');
  assert.equal(quoteIdentifier('we"ird', 'onhost'), '"we""ird"');
  assert.equal(quoteIdentifier('1st', 'onhost'), '"1st"');
});

test('literals quote text and pass numbers through', () => {
  assert.equal(sqlLiteral("o'brien", 'varchar(20)', 'postgresql'), "'o''brien'");
  assert.equal(sqlLiteral('42', 'int', 'postgresql'), '42');
  assert.equal(sqlLiteral('42', 'varchar(10)', 'postgresql'), "'42'");
  assert.equal(sqlLiteral(null, 'int', 'mysql'), 'NULL');
});

test('buildUpdateStatement addresses rows by primary key', () => {
  const sql = buildUpdateStatement({
    target: { schema: 'public', table: 'users' },
    kind: 'postgresql',
    columns,
    resultColumns: ['id', 'name'],
    row: [7, 'ann'],
    column: 'name',
    value: "o'brien",
  });
  assert.equal(sql, `UPDATE "public"."users" SET "name" = 'o''brien' WHERE "id" = 7`);
});

test('buildDeleteStatement returns null without a primary key', () => {
  assert.equal(
    buildDeleteStatement({
      target: { table: 'users' },
      kind: 'sqlite',
      columns: [{ name: 'name' }],
      resultColumns: ['name'],
      row: ['ann'],
    }),
    null,
  );
  assert.equal(canEditRows(columns), true);
  const sql = buildDeleteStatement({
    target: { table: 'users' },
    kind: 'sqlite',
    columns,
    resultColumns: ['id', 'name'],
    row: [7, 'ann'],
  });
  assert.equal(sql, 'DELETE FROM `users` WHERE `id` = 7');
});

test('rowKeyValues requires the key to be part of the result set', () => {
  assert.deepEqual(rowKeyValues(columns, [7, 'ann'], ['id', 'name']), [{ column: columns[0], value: 7 }]);
  assert.equal(rowKeyValues(columns, [7, 'ann'], ['name']), null);
});
