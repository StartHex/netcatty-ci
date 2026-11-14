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

test('an on-host connection comes back with its own fields, steps included', () => {
  const form = formFromConnection({
    ...base,
    kind: 'onhost',
    sshHostId: 'host-1',
    username: 'app',
    password: 'secret',
    onHost: {
      mode: 'direct',
      dbType: 'imdb',
      server: '192.0.2.20:9500',
      envCommand: '. ~/.bash_profile',
      loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }],
    },
  } as DatabaseConnection);
  assert.equal(form.kind, 'onhost');
  assert.equal(form.sshHostId, 'host-1');
  assert.equal(form.username, 'app');
  assert.deepEqual(form.onHost, {
    mode: 'direct',
    dbNo: '',
    dbType: 'imdb',
    server: '192.0.2.20:9500',
    envCommand: '. ~/.bash_profile',
    python: '',
    loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }],
  });
});

test('the on-host driver\'s automatic encoding is the form\'s default entry', () => {
  const auto = formFromConnection({
    ...base,
    kind: 'onhost',
    sshHostId: 'host-1',
    clientEncoding: 'auto',
  } as DatabaseConnection);
  assert.equal(auto.clientEncoding, '');
  assert.equal(auto.onHost.mode, 'config', 'a connection saved without settings uses db.cfg');

  const gbk = formFromConnection({
    ...base,
    kind: 'onhost',
    sshHostId: 'host-1',
    clientEncoding: 'gbk',
  } as DatabaseConnection);
  assert.equal(gbk.clientEncoding, 'gbk');

  // Other kinds have no such entry: what was saved is what is shown.
  const mysql = formFromConnection({ ...base, kind: 'mysql', clientEncoding: 'auto' } as DatabaseConnection);
  assert.equal(mysql.clientEncoding, 'auto');
});
