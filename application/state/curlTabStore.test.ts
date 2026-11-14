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

const storeModule = await import('./curlTabStore.ts');
const { curlTabStore, toCurlTabId, isCurlTabId, fromCurlTabId } = storeModule;

test('curl tab ids round-trip through the prefix helpers', () => {
  assert.equal(toCurlTabId('curltab_1'), 'curl:curltab_1');
  assert.equal(isCurlTabId('curl:curltab_1'), true);
  assert.equal(isCurlTabId('database:db_1'), false);
  assert.equal(isCurlTabId('vault'), false);
  assert.equal(fromCurlTabId('curl:curltab_1'), 'curltab_1');
});

test('sync publishes summaries and only notifies on change', () => {
  const seen: number[] = [];
  const unsubscribe = curlTabStore.subscribe(() => seen.push(curlTabStore.getTabs().length));
  curlTabStore.sync(
    [{ id: 'curltab_1', title: 'List users', method: 'GET', status: 'idle' }],
    'curltab_1',
  );
  curlTabStore.sync(
    [{ id: 'curltab_1', title: 'List users', method: 'GET', status: 'idle' }],
    'curltab_1',
  );
  assert.deepEqual(seen, [1]);
  assert.equal(curlTabStore.getActiveTabId(), 'curltab_1');
  unsubscribe();
  curlTabStore.sync([], null);
});

test('open and close requests can be cleared by nonce', () => {
  curlTabStore.requestOpen('req_9');
  const open = curlTabStore.getRequest();
  assert.equal(open?.type, 'open');
  if (open?.type === 'open') assert.equal(open.requestId, 'req_9');
  curlTabStore.clearRequest(open!.nonce);
  assert.equal(curlTabStore.getRequest(), null);

  curlTabStore.requestClose('curltab_3');
  const close = curlTabStore.getRequest();
  assert.equal(close?.type, 'close');
  if (close?.type === 'close') assert.equal(close.tabId, 'curltab_3');
});

test('persisted tabs drop invalid rows and keep the active tab', () => {
  curlTabStore.saveDrafts(
    [
      { id: 'curltab_1', title: 'One', method: 'GET', status: 'idle' },
      { id: 'curltab_2', title: 'Two', method: 'POST', status: 'done', requestId: 'req_2' },
    ],
    'curltab_2',
  );
  const persisted = curlTabStore.loadPersisted();
  assert.equal(persisted?.tabs.length, 2);
  assert.equal(persisted?.tabs[1].requestId, 'req_2');
  assert.equal(persisted?.activeTabId, 'curltab_2');

  (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
    'netcatty_http_tabs_v1',
    JSON.stringify({ tabs: [{ id: 1 }, { id: 'ok', title: 'Yes' }] }),
  );
  const filtered = curlTabStore.loadPersisted();
  assert.equal(filtered?.tabs.length, 1);
  assert.equal(filtered?.tabs[0].id, 'ok');
});

test('close requests raised in the same tick are all delivered, oldest first', () => {
  for (let request = curlTabStore.getRequest(); request; request = curlTabStore.getRequest()) {
    curlTabStore.takeRequest(request.nonce);
  }
  // "Close all" with three Curl tabs open.
  curlTabStore.requestClose('curltab_1');
  curlTabStore.requestClose('curltab_2');
  curlTabStore.requestClose('curltab_3');

  const handled: string[] = [];
  for (let request = curlTabStore.getRequest(); request; request = curlTabStore.getRequest()) {
    assert.equal(curlTabStore.takeRequest(request.nonce), true);
    assert.equal(curlTabStore.takeRequest(request.nonce), false, 'a request is taken once');
    if (request.type === 'close') handled.push(request.tabId);
  }
  assert.deepEqual(handled, ['curltab_1', 'curltab_2', 'curltab_3']);
  assert.equal(curlTabStore.getRequest(), null);
});

