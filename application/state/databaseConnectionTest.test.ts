import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseConnection, DbConnectionTarget, DbTestConnectionResult } from '../../domain/models.ts';
import type { DatabaseTunnelResult } from '../../infrastructure/services/databaseTunnelService.ts';
import { testDatabaseConnectionThroughHost } from './databaseConnectionTest.ts';

const onHost: DatabaseConnection = {
  id: 'db-1',
  label: 'Billing on host',
  kind: 'onhost',
  sshHostId: 'host-1',
  onHost: { mode: 'config', loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }] },
};

const tunneled: DatabaseConnection = {
  id: 'db-2',
  label: 'Orders',
  kind: 'mysql',
  host: '10.0.0.5',
  port: 3306,
  username: 'app',
  password: 'secret',
  sshHostId: 'host-1',
};

function steps(options: {
  tunnel?: DatabaseTunnelResult | Error;
  answer?: DbTestConnectionResult | Error;
} = {}) {
  const log = {
    ensured: [] as DatabaseConnection[],
    closed: [] as string[],
    targets: [] as DbConnectionTarget[],
    order: [] as string[],
  };
  let counter = 0;
  return {
    log,
    steps: {
      nonce: () => `n${(counter += 1)}`,
      ensureTunnel: async (connection: DatabaseConnection) => {
        log.ensured.push(connection);
        log.order.push('ensure');
        const tunnel = options.tunnel ?? { ok: true as const, host: '127.0.0.1', port: 50123, relayToken: 'tok' };
        if (tunnel instanceof Error) throw tunnel;
        return tunnel;
      },
      closeTunnel: async (connectionId: string) => {
        log.closed.push(connectionId);
        log.order.push('close');
      },
      testTarget: async (target: DbConnectionTarget) => {
        log.targets.push(target);
        log.order.push('test');
        const answer = options.answer ?? { ok: true, durationMs: 12, serverVersion: 'DMDB' };
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

test('the test goes through a tunnel of its own and takes it down afterwards', async () => {
  const run = steps();
  const result = await testDatabaseConnectionThroughHost(onHost, run.steps);

  assert.deepEqual(result, { ok: true, durationMs: 12, serverVersion: 'DMDB' });
  assert.equal(run.log.ensured.length, 1);
  const probe = run.log.ensured[0];
  assert.notEqual(probe.id, onHost.id, 'not the key an open tab keeps its tunnel under');
  assert.equal(probe.id, 'db-1:test:n1');
  assert.equal(probe.sshHostId, 'host-1');
  assert.deepEqual(probe.onHost, onHost.onHost, 'the draft is what gets dialed');
  assert.deepEqual(run.log.closed, [probe.id], 'what the test opened is closed');
  assert.deepEqual(run.log.order, ['ensure', 'test', 'close']);
});

test('the driver gets the local end of the session and the token that opens it', async () => {
  const run = steps();
  await testDatabaseConnectionThroughHost(onHost, run.steps);

  const target = run.log.targets[0];
  assert.equal(target.id, 'db-1', 'the target is still this connection');
  assert.equal(target.kind, 'onhost');
  assert.equal(target.host, '127.0.0.1');
  assert.equal(target.port, 50123);
  assert.equal(target.onHost?.relayToken, 'tok');
  assert.deepEqual(target.onHost?.loginSteps, [{ expect: 'Enter IP', send: '192.0.2.14' }]);
});

test('a tunneled network connection is tested at the tunnel\'s local end', async () => {
  const run = steps({ tunnel: { ok: true, host: '127.0.0.1', port: 50200 } });
  await testDatabaseConnectionThroughHost(tunneled, run.steps);

  const target = run.log.targets[0];
  assert.equal(target.host, '127.0.0.1');
  assert.equal(target.port, 50200);
  assert.equal(target.username, 'app');
  assert.equal(target.password, 'secret');
  assert.deepEqual(run.log.closed, ['db-2:test:n1']);
});

test('two tests of the same connection do not share a tunnel', async () => {
  const run = steps();
  await Promise.all([
    testDatabaseConnectionThroughHost(onHost, run.steps),
    testDatabaseConnectionThroughHost(onHost, run.steps),
  ]);
  const keys = run.log.ensured.map((connection) => connection.id);
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual([...run.log.closed].sort(), [...keys].sort());
});

test('a host that cannot be reached is the answer, and nothing is left to close', async () => {
  const run = steps({ tunnel: { ok: false, error: 'Could not log in to bastion: All configured authentication methods failed' } });
  const result = await testDatabaseConnectionThroughHost(onHost, run.steps);

  assert.deepEqual(result, {
    ok: false,
    durationMs: 0,
    error: 'Could not log in to bastion: All configured authentication methods failed',
  });
  assert.equal(run.log.targets.length, 0, 'the database is not dialed without a way to it');
  assert.deepEqual(run.log.closed, []);
});

test('a tunnel that throws is reported, not thrown', async () => {
  const run = steps({ tunnel: new Error('bridge unavailable') });
  const result = await testDatabaseConnectionThroughHost(onHost, run.steps);
  assert.deepEqual(result, { ok: false, durationMs: 0, error: 'bridge unavailable' });
});

test('a failed test still takes its tunnel down, and keeps what the host said', async () => {
  const failure: DbTestConnectionResult = {
    ok: false,
    durationMs: 31000,
    error: 'Login step 1 timed out after 30s waiting for "Enter IP"',
    errorCode: 'onhost-login-step',
    errorDetail: 'Last login: ...\nOpt> ',
  };
  const run = steps({ answer: failure });
  const result = await testDatabaseConnectionThroughHost(onHost, run.steps);

  assert.deepEqual(result, failure);
  assert.deepEqual(run.log.closed, ['db-1:test:n1']);
});

test('a test that throws still takes its tunnel down', async () => {
  const run = steps({ answer: new Error('ipc failed') });
  const result = await testDatabaseConnectionThroughHost(onHost, run.steps);

  assert.deepEqual(result, { ok: false, durationMs: 0, error: 'ipc failed' });
  assert.deepEqual(run.log.closed, ['db-1:test:n1']);
});

test('a tunnel that will not close does not turn a passed test into a failure', async () => {
  const run = steps();
  const result = await testDatabaseConnectionThroughHost(onHost, {
    ...run.steps,
    closeTunnel: async () => {
      throw new Error('already gone');
    },
  });
  assert.equal(result.ok, true);
  // The rejection is swallowed: give it a turn to prove nothing is unhandled.
  await new Promise((resolve) => setImmediate(resolve));
});
