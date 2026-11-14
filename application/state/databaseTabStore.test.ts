import assert from 'node:assert/strict';
import test from 'node:test';

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
} as Storage;

const storeModule = await import('./databaseTabStore.ts');
const { databaseTabStore, toDatabaseTabId, isDatabaseTabId, fromDatabaseTabId } = storeModule;

test('database tab ids round-trip through the prefix helpers', () => {
  assert.equal(toDatabaseTabId('db_1'), 'database:db_1');
  assert.equal(isDatabaseTabId('database:db_1'), true);
  assert.equal(isDatabaseTabId('editor:abc'), false);
  assert.equal(isDatabaseTabId('vault'), false);
  assert.equal(fromDatabaseTabId('database:db_1'), 'db_1');
});

test('sync publishes summaries and notifies only on change', () => {
  const seen: number[] = [];
  const unsubscribe = databaseTabStore.subscribe(() => seen.push(databaseTabStore.getTabs().length));
  databaseTabStore.sync(
    [{ id: 'db_1', connectionId: 'conn_1', title: 'Prod', kind: 'postgresql', status: 'ready' }],
    'db_1',
  );
  databaseTabStore.sync(
    [{ id: 'db_1', connectionId: 'conn_1', title: 'Prod', kind: 'postgresql', status: 'ready' }],
    'db_1',
  );
  assert.deepEqual(seen, [1]);
  assert.equal(databaseTabStore.getActiveTabId(), 'db_1');
  unsubscribe();
  databaseTabStore.sync([], null);
});

test('requests carry connection ids and can be cleared by nonce', () => {
  databaseTabStore.requestOpen('conn_9', { forceNew: true });
  const open = databaseTabStore.getRequest();
  assert.equal(open?.type, 'open');
  assert.equal(open?.connectionId, 'conn_9');
  assert.equal(open?.forceNew, true);
  databaseTabStore.clearRequest(open!.nonce);
  assert.equal(databaseTabStore.getRequest(), null);

  databaseTabStore.requestClose('db_3');
  const close = databaseTabStore.getRequest();
  assert.equal(close?.type, 'close');
  assert.equal(close?.tabId, 'db_3');
  databaseTabStore.clearRequest(close!.nonce);
});

test('persisted drafts survive a reload and drop malformed rows', () => {
  databaseTabStore.saveDrafts(
    [
      { id: 'db_1', connectionId: 'conn_1', title: 'Prod', sql: 'select 1' },
      { id: 'db_2', connectionId: 'conn_2', title: 'Dev', sql: '' },
    ],
    'db_2',
  );
  const persisted = databaseTabStore.loadPersisted();
  assert.equal(persisted?.tabs.length, 2);
  assert.equal(persisted?.activeTabId, 'db_2');
  assert.equal(databaseTabStore.loadDraft('db_1'), 'select 1');
  assert.equal(databaseTabStore.loadDraft('db_2'), '');

  memory.set(
    'netcatty_database_tabs_v1',
    JSON.stringify({ tabs: [{ id: 1 }, { id: 'db_3', connectionId: 'conn_3', title: 'X', sql: '' }] }),
  );
  const filtered = databaseTabStore.loadPersisted();
  assert.deepEqual(filtered?.tabs.map((tab) => tab.id), ['db_3']);
});

function drainRequests(): void {
  for (let request = databaseTabStore.getRequest(); request; request = databaseTabStore.getRequest()) {
    databaseTabStore.takeRequest(request.nonce);
  }
}

test('requests raised in the same tick are all delivered, oldest first', () => {
  drainRequests();
  let notified = 0;
  const unsubscribe = databaseTabStore.subscribe(() => {
    notified += 1;
  });

  // "Close all" with three database tabs open.
  databaseTabStore.requestClose('db_1');
  databaseTabStore.requestClose('db_2');
  databaseTabStore.requestClose('db_3');
  assert.equal(notified, 3);

  const handled: string[] = [];
  for (let request = databaseTabStore.getRequest(); request; request = databaseTabStore.getRequest()) {
    const waiting = notified;
    assert.equal(databaseTabStore.takeRequest(request.nonce), true);
    if (request.type === 'close') handled.push(request.tabId);
    // Whoever handles requests is told when another one is waiting behind.
    assert.equal(notified, databaseTabStore.getRequest() ? waiting + 1 : waiting);
  }
  assert.deepEqual(handled, ['db_1', 'db_2', 'db_3']);
  assert.equal(databaseTabStore.getRequest(), null);
  unsubscribe();
});

test('a request is taken once, however often the handler runs', () => {
  drainRequests();
  databaseTabStore.requestDuplicate('db_7');
  const request = databaseTabStore.getRequest();
  assert.equal(request?.type, 'duplicate');
  assert.equal(databaseTabStore.takeRequest(request!.nonce), true);
  assert.equal(databaseTabStore.takeRequest(request!.nonce), false, 'the second run must not duplicate again');
  assert.equal(databaseTabStore.getRequest(), null);
});

test('every request gets a nonce of its own', () => {
  drainRequests();
  databaseTabStore.requestOpen('conn_1');
  databaseTabStore.requestOpen('conn_1');
  const first = databaseTabStore.getRequest()!;
  databaseTabStore.takeRequest(first.nonce);
  const second = databaseTabStore.getRequest()!;
  assert.notEqual(second.nonce, first.nonce);
  drainRequests();
});

