import assert from 'node:assert/strict';
import test from 'node:test';

import { enDatabaseMessages as en } from '../i18n/locales/en/database.ts';
import { zhCNDatabaseMessages as zhCN } from '../i18n/locales/zh-CN/database.ts';
import { describeDatabaseConnectFailure, describeDatabaseError } from './databaseErrorMessages.ts';

const translate = (key: string): string => `t:${key}`;
/** What `t` does for a key the locale does not have. */
const untranslated = (key: string): string => key;
const inLocale = (messages: Record<string, string>) => (key: string): string => messages[key] ?? key;

const ON_HOST_CODES = [
  'onhost-relay',
  'onhost-login-step',
  'onhost-no-shell',
  'onhost-env',
  'onhost-no-python',
  'onhost-agent-start',
  'agent-exit',
  'library-missing',
];

test('an on-host failure names the stage in the UI language and keeps the specifics', () => {
  assert.equal(
    describeDatabaseError(
      { code: 'onhost-login-step', message: 'Login step 2 timed out after 30s waiting for "Enter IP"' },
      translate,
    ),
    't:databases.onhost.error.loginStep\nLogin step 2 timed out after 30s waiting for "Enter IP"',
  );
  assert.equal(
    describeDatabaseError({ code: 'onhost-no-python', message: '' }, translate),
    't:databases.onhost.error.noPython',
    'no specifics: the stage alone',
  );
});

test('every on-host stage has its line in the shipped locales', () => {
  for (const messages of [en, zhCN]) {
    const t = inLocale(messages as Record<string, string>);
    for (const code of ON_HOST_CODES) {
      const text = describeDatabaseError({ code, message: 'specifics' }, t);
      const [headline, rest] = text.split('\n');
      assert.equal(rest, 'specifics', code);
      assert.ok(headline && !headline.startsWith('databases.'), `${code} is translated: ${headline}`);
    }
  }
});

test('without a translation the bridge message is shown as before', () => {
  assert.equal(
    describeDatabaseError({ code: 'onhost-no-shell', message: 'No shell answered within 40s after logging in' }, untranslated),
    'No shell answered within 40s after logging in · onhost-no-shell',
  );
});

test('the database\'s own refusal is not dressed up as a stage of ours', () => {
  assert.equal(
    describeDatabaseError({ code: 'connect-failed', message: 'MDB-99998: cannot connect to rootserver' }, translate),
    'MDB-99998: cannot connect to rootserver · connect-failed',
  );
});

test('a failed connect is translated only for the codes that are explained', () => {
  assert.equal(
    describeDatabaseConnectFailure({ error: 'Connection timed out after 20s', errorCode: 'connect-timeout' }, translate, 'failed'),
    't:databases.workbench.connectTimeout',
  );
  assert.equal(
    describeDatabaseConnectFailure(
      { error: 'No Python interpreter was found on the host (tried python3, python)', errorCode: 'onhost-no-python' },
      translate,
      'failed',
    ),
    't:databases.onhost.error.noPython\nNo Python interpreter was found on the host (tried python3, python)',
  );
  // A driver's own code adds nothing to its message.
  assert.equal(
    describeDatabaseConnectFailure({ error: 'connect ECONNREFUSED 127.0.0.1:5432', errorCode: 'ECONNREFUSED' }, translate, 'failed'),
    'connect ECONNREFUSED 127.0.0.1:5432',
  );
  assert.equal(
    describeDatabaseConnectFailure({ error: 'password authentication failed', errorCode: '28P01' }, translate, 'failed'),
    'password authentication failed',
  );
  assert.equal(describeDatabaseConnectFailure({ error: 'plain' }, translate, 'failed'), 'plain');
  assert.equal(describeDatabaseConnectFailure({}, translate, 'failed'), 'failed');
  assert.equal(describeDatabaseConnectFailure({ error: '' }, translate, 'failed'), 'failed');
});
