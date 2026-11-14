import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

import { CONNECTION_IDLE_PROBE_MS, ON_HOST_PING_SQL, connectivityProbeSql } from './probe';

const require = createRequire(import.meta.url);

test('oracle needs a FROM clause, every other driver accepts select 1', () => {
  assert.equal(connectivityProbeSql('oracle'), 'select 1 from dual');
  assert.equal(connectivityProbeSql('mysql'), 'select 1');
  assert.equal(connectivityProbeSql('jdbc'), 'select 1');
  assert.equal(connectivityProbeSql(undefined), 'select 1');
});

test('the on-host driver is pinged, not queried, and the bridge knows the ping', () => {
  assert.equal(connectivityProbeSql('onhost'), ON_HOST_PING_SQL);
  // Two files spell this text, one per process. If they drift apart the ping
  // reaches the database as a statement and every idle check fails.
  const { PING_SQL } = require('../../electron/bridges/dbAgent/onHostSession.cjs') as { PING_SQL: string };
  assert.equal(PING_SQL, ON_HOST_PING_SQL);
});

test('the idle window matches the requested one minute', () => {
  assert.equal(CONNECTION_IDLE_PROBE_MS, 60_000);
});
