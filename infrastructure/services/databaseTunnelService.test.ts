import test from 'node:test';
import assert from 'node:assert/strict';

import type { DatabaseConnection } from '../../domain/models';
import {
  applyDatabaseTunnel,
  ensureDatabaseTunnel,
  resolveDatabaseRemoteEndpoint,
} from './databaseTunnelService.ts';

const jdbc = (patch: Partial<DatabaseConnection>): DatabaseConnection => ({
  id: 'c1',
  label: 'db',
  kind: 'jdbc',
  createdAt: 0,
  ...patch,
} as DatabaseConnection);

test('a JDBC tunnel dials what the URL says, not stale form fields', () => {
  assert.deepEqual(
    resolveDatabaseRemoteEndpoint(jdbc({
      host: 'old-host',
      port: 3306,
      jdbcUrl: 'jdbc:oracle:thin:@//10.9.9.9:1522/SVC',
    })),
    { host: '10.9.9.9', port: 1522 },
  );
});

test('a JDBC URL without a port uses the vendor default', () => {
  assert.deepEqual(
    resolveDatabaseRemoteEndpoint(jdbc({ jdbcUrl: 'jdbc:oracle:thin:@db.local/SVC' })),
    { host: 'db.local', port: 1521 },
  );
  assert.deepEqual(
    resolveDatabaseRemoteEndpoint(jdbc({ jdbcUrl: 'jdbc:mysql://db.local/app' })),
    { host: 'db.local', port: 3306 },
  );
});

test('built-in kinds keep using the host and port fields', () => {
  assert.deepEqual(
    resolveDatabaseRemoteEndpoint(jdbc({ kind: 'mysql', host: '10.0.0.5' })),
    { host: '10.0.0.5', port: 3306 },
  );
});

test('an SSH host with a URL that names no endpoint fails instead of connecting directly', async () => {
  const result = await ensureDatabaseTunnel(
    jdbc({ sshHostId: 'h1', jdbcUrl: 'jdbc:sqlserver://;serverName=x;port=1433' }),
    { hosts: [], keys: [], identities: [] },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /cannot go through the SSH host/);
});

test('an on-host connection without its host is refused before anything is dialed', async () => {
  const result = await ensureDatabaseTunnel(
    jdbc({ kind: 'onhost', onHost: { mode: 'config' } }),
    { hosts: [], keys: [], identities: [] },
  );
  assert.deepEqual(result, { ok: false, error: 'Choose the SSH host this connection runs on' });
});

test('an on-host connection whose host was deleted says so', async () => {
  const result = await ensureDatabaseTunnel(
    jdbc({ kind: 'onhost', sshHostId: 'gone', onHost: { mode: 'config' } }),
    { hosts: [], keys: [], identities: [] },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /no longer exists/);
});

test('the on-host driver is pointed at the shell relay and given its token', () => {
  const target = applyDatabaseTunnel(
    { id: 'c1', kind: 'onhost', username: 'app', onHost: { mode: 'config', dbNo: 2 } },
    { host: '127.0.0.1', port: 50123, relayToken: 'token-123' },
  );
  assert.equal(target.host, '127.0.0.1');
  assert.equal(target.port, 50123);
  assert.deepEqual(target.onHost, { mode: 'config', dbNo: 2, relayToken: 'token-123' });
  assert.equal(target.jdbcUrl, undefined);
});

test('other kinds are only re-pointed, and a JDBC URL is rewritten with them', () => {
  const mysql = applyDatabaseTunnel(
    { id: 'c2', kind: 'mysql', host: 'db.internal', port: 3306 },
    { host: '127.0.0.1', port: 50124 },
  );
  assert.deepEqual(mysql, { id: 'c2', kind: 'mysql', host: '127.0.0.1', port: 50124 });

  const viaJdbc = applyDatabaseTunnel(
    { id: 'c3', kind: 'jdbc', jdbcUrl: 'jdbc:mysql://db.internal:3306/app' },
    { host: '127.0.0.1', port: 50125 },
  );
  assert.equal(viaJdbc.jdbcUrl, 'jdbc:mysql://127.0.0.1:50125/app');
  assert.equal('onHost' in viaJdbc, false);
});

