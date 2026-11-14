import test from 'node:test';
import assert from 'node:assert/strict';

import type { DatabaseConnection } from '../../domain/models';
import { ensureDatabaseTunnel, resolveDatabaseRemoteEndpoint } from './databaseTunnelService.ts';

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
