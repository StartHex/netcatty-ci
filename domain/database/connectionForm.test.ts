import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseConnection } from '../models/database.ts';
import {
  EMPTY_DATABASE_CONNECTION_FORM,
  connectionFromForm,
  formFromConnection,
  formUsesAccount,
} from './connectionForm.ts';

const base = {
  id: 'db-1',
  label: 'Conn',
  createdAt: 1,
} satisfies Partial<DatabaseConnection>;

test('a new form starts as a PostgreSQL connection on its default port', () => {
  assert.equal(EMPTY_DATABASE_CONNECTION_FORM.kind, 'postgresql');
  assert.equal(EMPTY_DATABASE_CONNECTION_FORM.port, '5432');
  assert.equal(EMPTY_DATABASE_CONNECTION_FORM.onHost.mode, 'config');
});

test('which kinds log in with an account typed into the form', () => {
  const form = (patch: Partial<typeof EMPTY_DATABASE_CONNECTION_FORM>) => ({ ...EMPTY_DATABASE_CONNECTION_FORM, ...patch });
  assert.equal(formUsesAccount(form({ kind: 'mysql' })), true);
  assert.equal(formUsesAccount(form({ kind: 'jdbc' })), true);
  assert.equal(formUsesAccount(form({ kind: 'sqlite' })), false);
  // db.cfg mode takes the login from the host's own configuration.
  assert.equal(formUsesAccount(form({ kind: 'onhost' })), false);
  assert.equal(
    formUsesAccount(form({ kind: 'onhost', onHost: { ...EMPTY_DATABASE_CONNECTION_FORM.onHost, mode: 'direct' } })),
    true,
  );
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

test('saving an unchanged network connection keeps what it had', () => {
  const saved = {
    ...base,
    kind: 'mysql',
    host: '10.0.0.5',
    port: 3307,
    database: 'app',
    username: 'reader',
    password: 'secret',
    savePassword: true,
    sslMode: 'require',
    clientEncoding: 'gbk',
    sshHostId: 'host-9',
    readOnly: true,
    initSql: 'set names gbk',
    group: 'Billing',
    colorTag: 'red',
    savedQueries: [{ id: 'q1', name: 'Recent', sql: 'select 1', createdAt: 5 }],
  } as DatabaseConnection;

  const again = connectionFromForm(formFromConnection(saved), saved);
  for (const key of [
    'id', 'label', 'kind', 'host', 'port', 'database', 'username', 'password', 'savePassword', 'sslMode',
    'clientEncoding', 'sshHostId', 'readOnly', 'initSql', 'group', 'colorTag', 'createdAt',
  ] as const) {
    assert.deepEqual(again[key], saved[key], key);
  }
  assert.deepEqual(again.savedQueries, saved.savedQueries, 'what the form does not show is not lost');
  assert.equal(again.onHost, undefined);
});

test('an on-host connection in db.cfg mode is saved without an account or an address', () => {
  const form = formFromConnection({
    ...base,
    kind: 'onhost',
    sshHostId: 'host-1',
    onHost: { mode: 'config', dbNo: 2, loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }] },
  } as DatabaseConnection);
  // Left over from another kind, or typed while direct mode was selected.
  form.username = 'app';
  form.password = 'secret';
  form.host = '10.0.0.5';
  form.port = '3306';
  form.database = 'app';

  const saved = connectionFromForm(form, base);
  assert.equal(saved.kind, 'onhost');
  assert.equal(saved.sshHostId, 'host-1', 'the host it runs on');
  assert.deepEqual(saved.onHost, {
    mode: 'config',
    dbNo: 2,
    loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }],
  });
  // The host's own configuration holds the login: none is kept here.
  assert.equal(saved.username, undefined);
  assert.equal(saved.password, undefined);
  assert.equal(saved.host, undefined);
  assert.equal(saved.port, undefined);
  assert.equal(saved.database, undefined);
  assert.equal(saved.sslMode, undefined);
});

test('an on-host connection in direct mode keeps the account it logs in with', () => {
  const form = formFromConnection({
    ...base,
    kind: 'onhost',
    sshHostId: 'host-1',
    username: 'app',
    password: 'secret',
    clientEncoding: 'gb18030',
    onHost: { mode: 'direct', dbType: 'dmdb', server: '192.0.2.20:9500' },
  } as DatabaseConnection);

  const saved = connectionFromForm(form, base);
  assert.equal(saved.username, 'app');
  assert.equal(saved.password, 'secret');
  assert.equal(saved.clientEncoding, 'gb18030');
  assert.deepEqual(saved.onHost, { mode: 'direct', dbType: 'dmdb', server: '192.0.2.20:9500' });

  // An unsaved password stays out of the vault, as for every other kind.
  const unsaved = connectionFromForm({ ...form, savePassword: false }, base);
  assert.equal(unsaved.password, undefined);
  assert.equal(unsaved.username, 'app');
});

test('changing the kind of an on-host connection drops its on-host settings', () => {
  const existing = {
    ...base,
    kind: 'onhost',
    sshHostId: 'host-1',
    onHost: { mode: 'config', loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }] },
  } as DatabaseConnection;
  const form = { ...formFromConnection(existing), kind: 'mysql' as const, host: '10.0.0.5', port: '3306' };

  const saved = connectionFromForm(form, existing);
  assert.equal(saved.kind, 'mysql');
  assert.equal(saved.onHost, undefined);
  assert.equal(saved.host, '10.0.0.5');
  assert.equal(saved.sshHostId, 'host-1', 'the host stays on as the jump host the form now shows');
});

test('a sqlite connection has neither an account nor a host', () => {
  const form = { ...formFromConnection({ ...base, kind: 'sqlite', sqlitePath: '/tmp/app.db' } as DatabaseConnection) };
  form.username = 'left-over';
  form.password = 'left-over';
  form.sshHostId = 'host-1';

  const saved = connectionFromForm(form, base);
  assert.equal(saved.sqlitePath, '/tmp/app.db');
  assert.equal(saved.username, undefined);
  assert.equal(saved.password, undefined);
  assert.equal(saved.sshHostId, undefined);
});

test('a JDBC connection falls back to its registered driver for the class and the jars', () => {
  const driver = {
    id: 'drv-1',
    name: 'Example',
    jarPath: '/drivers/a.jar',
    jarPaths: ['/drivers/a.jar', '/drivers/b.jar'],
    driverClass: 'com.example.Driver',
  };
  const form = {
    ...EMPTY_DATABASE_CONNECTION_FORM,
    kind: 'jdbc' as const,
    label: 'Memory db',
    jdbcUrl: '  jdbc:example://host:1/db  ',
    jdbcDriverId: 'drv-1',
    javaPath: ' /usr/bin/java ',
  };

  const saved = connectionFromForm(form, base, driver);
  assert.equal(saved.jdbcUrl, 'jdbc:example://host:1/db');
  assert.equal(saved.jdbcDriverId, 'drv-1');
  assert.equal(saved.jdbcDriverClass, 'com.example.Driver');
  assert.deepEqual(saved.jdbcDriverPaths, ['/drivers/a.jar', '/drivers/b.jar']);
  assert.equal(saved.javaPath, '/usr/bin/java');

  // What the form itself says wins over the registered driver.
  const own = connectionFromForm(
    { ...form, jdbcDriverClass: 'org.other.Driver', jdbcDriverPaths: ['/own.jar'] },
    base,
    driver,
  );
  assert.equal(own.jdbcDriverClass, 'org.other.Driver');
  assert.deepEqual(own.jdbcDriverPaths, ['/own.jar']);

  // An older driver entry with a single jar.
  const single = connectionFromForm(form, base, { id: 'drv-1', name: 'Example', jarPath: '/drivers/a.jar' });
  assert.deepEqual(single.jdbcDriverPaths, ['/drivers/a.jar']);

  // JDBC fields do not leak into another kind.
  const mysql = connectionFromForm({ ...form, kind: 'mysql' as const }, base, driver);
  assert.equal(mysql.jdbcUrl, undefined);
  assert.equal(mysql.jdbcDriverClass, undefined);
  assert.equal(mysql.jdbcDriverPaths, undefined);
  assert.equal(mysql.javaPath, undefined);
});

test('a blank form field is saved as absent, not as an empty string', () => {
  const saved = connectionFromForm(
    { ...EMPTY_DATABASE_CONNECTION_FORM, kind: 'mysql', label: '  Orders  ', host: ' db.internal ', port: '3306' },
    base,
  );
  assert.equal(saved.label, 'Orders');
  assert.equal(saved.host, 'db.internal');
  assert.equal(saved.port, 3306);
  assert.equal(saved.database, undefined);
  assert.equal(saved.username, undefined);
  assert.equal(saved.initSql, undefined);
  assert.equal(saved.group, undefined);
  assert.equal(saved.colorTag, undefined);
  assert.equal(saved.sshHostId, undefined);
  assert.equal(saved.clientEncoding, undefined);
});
