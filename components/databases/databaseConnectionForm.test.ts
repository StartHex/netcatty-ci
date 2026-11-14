import test from 'node:test';
import assert from 'node:assert/strict';

import { formFromConnection } from './DatabaseConnectionDialog.tsx';
import type { DatabaseConnection } from '../../domain/models';

const base = {
  id: 'db-1',
  label: 'Conn',
  createdAt: 1,
} satisfies Partial<DatabaseConnection>;

test('editing keeps the saved kind instead of falling back to postgresql', () => {
  const mysql = formFromConnection({ ...base, kind: 'mysql', host: '127.0.0.1', port: 3306 } as DatabaseConnection);
  assert.equal(mysql.kind, 'mysql');
  assert.equal(mysql.port, '3306');

  const jdbc = formFromConnection({
    ...base,
    kind: 'jdbc',
    jdbcUrl: 'jdbc:e-mobile://host:9256/dmdb',
    jdbcDriverClass: 'com.sitech.dmdb.Driver',
  } as DatabaseConnection);
  assert.equal(jdbc.kind, 'jdbc');
  assert.equal(jdbc.jdbcDriverClass, 'com.sitech.dmdb.Driver');
});

test('credentials survive a round trip through the form', () => {
  const form = formFromConnection({
    ...base,
    kind: 'mysql',
    username: 'app',
    password: 'secret',
    savePassword: true,
  } as DatabaseConnection);
  assert.equal(form.username, 'app');
  assert.equal(form.password, 'secret');
});
