import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DATABASE_KINDS,
  ON_HOST_MAX_LOGIN_STEPS,
  databaseConnectionTarget,
  databaseDisplayTarget,
  databaseKindUsesOnHost,
  isDatabaseConnectionReady,
  sanitizeDatabaseConnection,
  sanitizeOnHostSettings,
} from './database.ts';

test('on-host is a database kind of its own', () => {
  assert.ok(DATABASE_KINDS.includes('onhost'));
  assert.equal(databaseKindUsesOnHost('onhost'), true);
  assert.equal(databaseKindUsesOnHost('jdbc'), false);
});

test('settings default to the host config and keep only what their mode uses', () => {
  assert.deepEqual(sanitizeOnHostSettings(undefined), { mode: 'config' });
  assert.deepEqual(sanitizeOnHostSettings({ mode: 'config', dbNo: 2, dbType: 'dmdb', server: 'h:1' }), {
    mode: 'config',
    dbNo: 2,
  });
  assert.deepEqual(sanitizeOnHostSettings({ mode: 'direct', dbNo: 2, dbType: 'dmdb', server: ' h:9500 ' }), {
    mode: 'direct',
    dbType: 'dmdb',
    server: 'h:9500',
  });
  // Unknown values are dropped, never guessed.
  assert.deepEqual(sanitizeOnHostSettings({ mode: 'sideways', dbNo: 0, dbType: 'db2' }), { mode: 'config' });
  assert.deepEqual(sanitizeOnHostSettings({ mode: 'direct', dbType: 'db2' }), { mode: 'direct' });
  assert.deepEqual(
    sanitizeOnHostSettings({ mode: 'config', envCommand: '  . ~/.bash_profile ', python: ' /usr/bin/python2 ' }),
    { mode: 'config', envCommand: '. ~/.bash_profile', python: '/usr/bin/python2' },
  );
});

test('login steps need something to wait for, may send nothing, and are bounded', () => {
  const settings = sanitizeOnHostSettings({
    mode: 'config',
    loginSteps: [
      { expect: ' 请输入IP ', send: '192.0.2.14' },
      { expect: '', send: 'dropped: nothing to wait for' },
      { expect: 'Press Enter', send: '' },
      { expect: '/account \\[\\d+-\\d+\\]/i', send: '1', timeoutMs: 20 },
      { expect: 'slow menu', send: '2', timeoutMs: 99_999_999 },
      'not a step',
    ],
  });
  assert.deepEqual(settings.loginSteps, [
    { expect: '请输入IP', send: '192.0.2.14' },
    { expect: 'Press Enter', send: '' },
    { expect: '/account \\[\\d+-\\d+\\]/i', send: '1', timeoutMs: 1000 },
    { expect: 'slow menu', send: '2', timeoutMs: 300_000 },
  ]);

  const many = sanitizeOnHostSettings({
    mode: 'config',
    loginSteps: Array.from({ length: 40 }, (_, index) => ({ expect: `prompt ${index}`, send: 'x' })),
  });
  assert.equal(many.loginSteps?.length, ON_HOST_MAX_LOGIN_STEPS);
  assert.equal(sanitizeOnHostSettings({ mode: 'config', loginSteps: [] }).loginSteps, undefined);
});

test('only on-host connections carry on-host settings', () => {
  const onHost = sanitizeDatabaseConnection({
    id: 'c1',
    label: 'billing',
    kind: 'onhost',
    sshHostId: 'host_1',
    onHost: { mode: 'direct', dbType: 'dmdb', server: 'cluster:9500' },
  });
  assert.deepEqual(onHost.onHost, { mode: 'direct', dbType: 'dmdb', server: 'cluster:9500' });

  const jdbc = sanitizeDatabaseConnection({
    id: 'c2',
    kind: 'jdbc',
    onHost: { mode: 'direct', dbType: 'dmdb', server: 'cluster:9500' },
  });
  assert.equal('onHost' in jdbc, false);

  // A connection saved before the settings existed still opens the editor.
  assert.deepEqual(sanitizeDatabaseConnection({ id: 'c3', kind: 'onhost' }).onHost, { mode: 'config' });
});

test('an on-host connection is ready once it has a host, and an account for direct mode', () => {
  const base = { id: 'c1', label: 'x', kind: 'onhost' as const };
  assert.equal(isDatabaseConnectionReady(sanitizeDatabaseConnection({ ...base })), false, 'no host to run on');
  assert.equal(
    isDatabaseConnectionReady(sanitizeDatabaseConnection({ ...base, sshHostId: 'h' })),
    true,
    'the host config carries the login',
  );
  assert.equal(
    isDatabaseConnectionReady(sanitizeDatabaseConnection({ ...base, sshHostId: 'h', onHost: { mode: 'direct' } })),
    false,
  );
  assert.equal(
    isDatabaseConnectionReady(
      sanitizeDatabaseConnection({
        ...base,
        sshHostId: 'h',
        username: 'app',
        onHost: { mode: 'direct', dbType: 'dmdb', server: 'cluster:9500' },
      }),
    ),
    true,
  );
});

test('the list shows what the driver will open', () => {
  const base = { id: 'c1', label: 'x', kind: 'onhost' as const, sshHostId: 'h' };
  assert.equal(databaseDisplayTarget(sanitizeDatabaseConnection({ ...base })), 'db.cfg');
  assert.equal(
    databaseDisplayTarget(sanitizeDatabaseConnection({ ...base, onHost: { mode: 'config', dbNo: 2 } })),
    'db.cfg DB02',
  );
  assert.equal(
    databaseDisplayTarget(
      sanitizeDatabaseConnection({ ...base, onHost: { mode: 'direct', dbType: 'dmdb', server: 'cluster:9500' } }),
    ),
    'dmdb:cluster:9500',
  );
});

test('the bridge target carries the settings, and only for on-host connections', () => {
  const connection = sanitizeDatabaseConnection({
    id: 'c1',
    kind: 'onhost',
    sshHostId: 'h',
    username: 'app',
    password: 'secret',
    clientEncoding: 'gb18030',
    onHost: { mode: 'config', dbNo: 1, loginSteps: [{ expect: 'IP', send: '192.0.2.14' }] },
  });
  const target = databaseConnectionTarget(connection);
  assert.equal(target.kind, 'onhost');
  assert.deepEqual(target.onHost, { mode: 'config', dbNo: 1, loginSteps: [{ expect: 'IP', send: '192.0.2.14' }] });
  assert.equal(target.username, 'app');
  assert.equal(target.password, 'secret');
  assert.equal(target.clientEncoding, 'gb18030');
  assert.equal('relayToken' in (target.onHost ?? {}), false, 'the token is added per call, never stored');

  const plain = databaseConnectionTarget(sanitizeDatabaseConnection({ id: 'c2', kind: 'mysql', host: 'db' }));
  assert.equal('onHost' in plain, false);
});
