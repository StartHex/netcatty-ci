import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { DatabaseConnection } from '../../domain/models.ts';

// ---------------------------------------------------------------------------
// Environment: a storage, and a bridge whose connect can be held open, which is
// what a slow tunnel or an unreachable database looks like to the workbench.
// ---------------------------------------------------------------------------

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
});

type ConnectAnswer = {
  ok: boolean;
  durationMs: number;
  serverVersion?: string;
  /** The bridge sends its failures as objects; older call sites sent text. */
  error?: string | { message: string; code?: string; detail?: string };
};

const bridgeLog = {
  connects: [] as string[],
  disconnects: [] as string[],
  pending: [] as Array<(answer: ConnectAnswer) => void>,
  /** When set, connects answer at once instead of waiting to be released. */
  autoAnswer: null as ConnectAnswer | null,
  reset() {
    this.connects = [];
    this.disconnects = [];
    this.pending = [];
    this.autoAnswer = null;
  },
};

const bridge = {
  dbQuery: async () => ({ ok: true, result: { columns: [], rows: [], rowCount: 0, truncated: false } }),
  dbConnect: (target: { id: string }) => {
    bridgeLog.connects.push(target.id);
    if (bridgeLog.autoAnswer) return Promise.resolve(bridgeLog.autoAnswer);
    return new Promise<ConnectAnswer>((resolve) => bridgeLog.pending.push(resolve));
  },
  dbTables: async () => ({ ok: true, tables: [] }),
  dbDisconnect: async (request: { id: string }) => {
    bridgeLog.disconnects.push(request.id);
  },
  dbCancel: async () => undefined,
};

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    netcatty: bridge,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useDatabaseWorkbench } = await import('./useDatabaseWorkbench.ts');
const { databaseTabStore, toDatabaseTabId } = await import('./databaseTabStore.ts');
const { activeTabStore } = await import('./activeTabStore.ts');

type Workbench = ReturnType<typeof useDatabaseWorkbench>;

const connection = (id: string): DatabaseConnection => ({
  id,
  label: `db ${id}`,
  kind: 'postgresql',
  host: '10.0.0.5',
  port: 5432,
  database: 'app',
  username: 'app',
});

async function mountWorkbench(connections: DatabaseConnection[], frontTabId: string | null = null) {
  let workbench: Workbench | null = null;
  const Probe = ({ front }: { front: string | null }) => {
    workbench = useDatabaseWorkbench(connections, undefined, front);
    return null;
  };
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(React.createElement(Probe, { front: frontTabId }));
  });
  return {
    get current(): Workbench {
      assert.ok(workbench, 'the workbench rendered');
      return workbench;
    },
    async show(front: string | null) {
      await act(async () => {
        renderer?.update(React.createElement(Probe, { front }));
      });
    },
    async unmount() {
      await act(async () => {
        renderer?.unmount();
      });
    },
  };
}

/** Lets promise chains started inside the workbench run to their next await. */
const settle = () => act(async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
});

function beforeEachCase() {
  storage.clear();
  bridgeLog.reset();
  activeTabStore.setActiveTabId('vault');
}

test('an opened connection is in front at once, and a late answer does not pull the user back', async () => {
  beforeEachCase();
  const conn = connection('conn_slow');
  const mounted = await mountWorkbench([conn]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });

    const tab = mounted.current.tabs[0];
    assert.ok(tab, 'the tab exists while the database has not answered');
    assert.equal(tab.status, 'connecting');
    assert.equal(bridgeLog.pending.length, 1, 'the dial is still in flight');
    assert.equal(
      activeTabStore.getActiveTabId(),
      toDatabaseTabId(tab.id),
      'the app is on the new tab without waiting for the connection',
    );
    assert.equal(mounted.current.activeTabId, tab.id);

    // The user moves on while it dials.
    activeTabStore.setActiveTabId('vault');
    await act(async () => {
      bridgeLog.pending[0]({ ok: true, durationMs: 5, serverVersion: 'PostgreSQL 16' });
    });
    await settle();

    assert.equal(mounted.current.tabs[0].status, 'ready');
    assert.equal(mounted.current.tabs[0].connected, true);
    assert.equal(activeTabStore.getActiveTabId(), 'vault', 'connecting never moves the app by itself');
  } finally {
    await mounted.unmount();
  }
});

test('a failed connection leaves the user on the tab that explains it', async () => {
  beforeEachCase();
  const conn = connection('conn_down');
  const mounted = await mountWorkbench([conn]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });
    const tabId = mounted.current.tabs[0].id;
    await act(async () => {
      bridgeLog.pending[0]({ ok: false, durationMs: 5, error: 'connection refused' });
    });
    await settle();

    assert.equal(mounted.current.tabs[0].status, 'error');
    assert.equal(mounted.current.tabs[0].error, 'connection refused');
    assert.equal(activeTabStore.getActiveTabId(), toDatabaseTabId(tabId));
  } finally {
    await mounted.unmount();
  }
});

test('a failed connection keeps the bridge\'s code and what the host printed', async () => {
  beforeEachCase();
  const conn = connection('conn_bastion');
  const mounted = await mountWorkbench([conn]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });
    await act(async () => {
      bridgeLog.pending[0]({
        ok: false,
        durationMs: 30010,
        error: {
          message: 'Login step 1 timed out after 30s waiting for "Enter IP"',
          code: 'onhost-login-step',
          detail: 'Last login: Sat Nov 14\nOpt> ',
        },
      });
    });
    await settle();

    const tab = mounted.current.tabs[0];
    assert.equal(tab.status, 'error');
    assert.match(tab.error ?? '', /Login step 1 timed out after 30s waiting for "Enter IP"/);
    assert.deepEqual(tab.errorDetail, {
      message: 'Login step 1 timed out after 30s waiting for "Enter IP"',
      code: 'onhost-login-step',
      detail: 'Last login: Sat Nov 14\nOpt> ',
    });
  } finally {
    await mounted.unmount();
  }
});

test('a driver\'s own failure code does not change what the tab says', async () => {
  beforeEachCase();
  const conn = connection('conn_refused');
  const mounted = await mountWorkbench([conn]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });
    await act(async () => {
      bridgeLog.pending[0]({
        ok: false,
        durationMs: 3,
        error: { message: 'connect ECONNREFUSED 10.0.0.5:5432', code: 'ECONNREFUSED' },
      });
    });
    await settle();

    const tab = mounted.current.tabs[0];
    assert.equal(tab.error, 'connect ECONNREFUSED 10.0.0.5:5432');
    assert.equal(tab.errorDetail, undefined, 'nothing more to show than the message');
  } finally {
    await mounted.unmount();
  }
});

test('asking for an open connection again goes to its tab; a copy gets a tab of its own', async () => {
  beforeEachCase();
  bridgeLog.autoAnswer = { ok: true, durationMs: 1 };
  const conn = connection('conn_a');
  const mounted = await mountWorkbench([conn]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });
    await settle();
    const first = mounted.current.tabs[0].id;

    activeTabStore.setActiveTabId('vault');
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });
    assert.equal(mounted.current.tabs.length, 1, 'no second tab for the same connection');
    assert.equal(bridgeLog.connects.length, 1, 'and no second dial');
    assert.equal(activeTabStore.getActiveTabId(), toDatabaseTabId(first));

    await act(async () => {
      databaseTabStore.requestDuplicate(first);
    });
    await settle();
    assert.equal(mounted.current.tabs.length, 2);
    const copy = mounted.current.tabs[1].id;
    assert.notEqual(copy, first);
    assert.equal(activeTabStore.getActiveTabId(), toDatabaseTabId(copy), 'the copy comes to the front');
  } finally {
    await mounted.unmount();
  }
});

test('"close all" closes every database tab and ends their shared session once', async () => {
  beforeEachCase();
  bridgeLog.autoAnswer = { ok: true, durationMs: 1 };
  const shared = connection('conn_shared');
  const other = connection('conn_other');
  const mounted = await mountWorkbench([shared, other]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(shared.id);
    });
    await act(async () => {
      databaseTabStore.requestOpen(shared.id, { forceNew: true });
    });
    await act(async () => {
      databaseTabStore.requestOpen(other.id);
    });
    await settle();
    const ids = mounted.current.tabs.map((tab) => tab.id);
    assert.equal(ids.length, 3);
    bridgeLog.disconnects = [];

    // One request per tab, raised in the same tick, the way the tab bar's
    // "close all" does it.
    await act(async () => {
      for (const id of ids) databaseTabStore.requestClose(id);
    });
    await settle();

    assert.deepEqual(mounted.current.tabs, [], 'no tab is left behind');
    assert.deepEqual(
      [...bridgeLog.disconnects].sort(),
      [other.id, shared.id].sort(),
      'each session ends once: the first of two sibling tabs must not end it, the second must',
    );
  } finally {
    await mounted.unmount();
  }
});

test('closing one of two tabs on a connection keeps the session for the other', async () => {
  beforeEachCase();
  bridgeLog.autoAnswer = { ok: true, durationMs: 1 };
  const conn = connection('conn_pair');
  const mounted = await mountWorkbench([conn]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });
    await act(async () => {
      databaseTabStore.requestOpen(conn.id, { forceNew: true });
    });
    await settle();
    const [first, second] = mounted.current.tabs.map((tab) => tab.id);
    bridgeLog.disconnects = [];

    await act(async () => {
      databaseTabStore.requestClose(first);
    });
    await settle();
    assert.deepEqual(mounted.current.tabs.map((tab) => tab.id), [second]);
    assert.deepEqual(bridgeLog.disconnects, [], 'the remaining tab still uses the session');
  } finally {
    await mounted.unmount();
  }
});

test('opening and closing back to back, before any render, still counts tabs correctly', async () => {
  beforeEachCase();
  bridgeLog.autoAnswer = { ok: true, durationMs: 1 };
  const conn = connection('conn_burst');
  const mounted = await mountWorkbench([conn]);
  try {
    let firstId = '';
    let againId = '';
    let copyId = '';
    await act(async () => {
      // No render happens between these calls: the rendered tab list is stale
      // for all but the first of them.
      firstId = mounted.current.openTab(conn);
      againId = mounted.current.openTab(conn);
      copyId = mounted.current.openTab(conn, { forceNew: true });
    });
    await settle();
    assert.equal(againId, firstId, 'the same connection is not given a second tab');
    assert.notEqual(copyId, firstId);
    assert.deepEqual(mounted.current.tabs.map((tab) => tab.id), [firstId, copyId]);
    assert.equal(bridgeLog.connects.length, 2);
    bridgeLog.disconnects = [];

    await act(async () => {
      mounted.current.closeTab(firstId);
      mounted.current.closeTab(copyId);
      mounted.current.closeTab(copyId);
    });
    await settle();
    assert.deepEqual(mounted.current.tabs, []);
    assert.deepEqual(
      bridgeLog.disconnects,
      [conn.id],
      'the second close sees the first one gone and ends the session; a repeated close does nothing',
    );
  } finally {
    await mounted.unmount();
  }
});

test('a tab closed while it is still dialing does not leave the session it opens behind', async () => {
  beforeEachCase();
  const conn = connection('conn_abandoned');
  const mounted = await mountWorkbench([conn]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(conn.id);
    });
    const tabId = mounted.current.tabs[0].id;
    await act(async () => {
      databaseTabStore.requestClose(tabId);
    });
    await settle();
    assert.deepEqual(mounted.current.tabs, []);
    const closesBeforeAnswer = bridgeLog.disconnects.length;

    // The database answers after the tab is gone: the session now exists in
    // the main process and nothing would ever close it.
    await act(async () => {
      bridgeLog.pending[0]({ ok: true, durationMs: 900 });
    });
    await settle();
    assert.equal(
      bridgeLog.disconnects.length,
      closesBeforeAnswer + 1,
      'the late session is closed once the dial comes back',
    );
    assert.equal(bridgeLog.disconnects.at(-1), conn.id);
    assert.deepEqual(mounted.current.tabs, [], 'and the closed tab does not come back');
  } finally {
    await mounted.unmount();
  }
});

test('restored tabs stay off the network until one of them is shown', async () => {
  beforeEachCase();
  const conn = connection('conn_restored');
  storage.set(
    'netcatty_database_tabs_v1',
    JSON.stringify({
      tabs: [
        { id: 'tab_r1', connectionId: conn.id, title: 'Restored one', sql: 'select 1' },
        { id: 'tab_r2', connectionId: conn.id, title: 'Restored two', sql: 'select 2' },
      ],
      activeTabId: 'tab_r1',
    }),
  );
  const mounted = await mountWorkbench([conn]);
  try {
    await settle();
    assert.deepEqual(mounted.current.tabs.map((tab) => tab.status), ['idle', 'idle']);
    assert.equal(bridgeLog.connects.length, 0, 'starting the app dials nothing');

    await mounted.show('tab_r2');
    assert.equal(bridgeLog.connects.length, 1, 'the tab that comes to the front dials');
    assert.equal(mounted.current.activeTabId, 'tab_r2', 'and is the one the workbench shows');
    assert.equal(mounted.current.tabs[1].status, 'connecting');
    assert.equal(mounted.current.tabs[0].status, 'idle', 'the other one still waits');

    await act(async () => {
      bridgeLog.pending[0]({ ok: true, durationMs: 3 });
    });
    await settle();
    assert.equal(mounted.current.tabs[1].status, 'ready');

    // Leaving and coming back does not dial again.
    await mounted.show(null);
    await mounted.show('tab_r2');
    assert.equal(bridgeLog.connects.length, 1);

    // The second pane shows a restored tab too.
    await act(async () => {
      mounted.current.connectIfIdle('tab_r1');
      mounted.current.connectIfIdle('tab_r1');
    });
    assert.equal(bridgeLog.connects.length, 2, 'asked twice in one tick, dialed once');
  } finally {
    await mounted.unmount();
  }
});

test('the workbench shows the tab the app has in front', async () => {
  beforeEachCase();
  bridgeLog.autoAnswer = { ok: true, durationMs: 1 };
  const first = connection('conn_one');
  const second = connection('conn_two');
  const mounted = await mountWorkbench([first, second]);
  try {
    await act(async () => {
      databaseTabStore.requestOpen(first.id);
    });
    await act(async () => {
      databaseTabStore.requestOpen(second.id);
    });
    await settle();
    const [firstTab, secondTab] = mounted.current.tabs.map((tab) => tab.id);
    assert.equal(mounted.current.activeTabId, secondTab);

    // The user clicks the first tab in the tab bar.
    await mounted.show(firstTab);
    assert.equal(mounted.current.activeTabId, firstTab);

    // Closing the tab in front: the tab bar moves to the other database tab,
    // and the workbench follows it in the same pass.
    await act(async () => {
      databaseTabStore.requestClose(firstTab);
      activeTabStore.setActiveTabId(toDatabaseTabId(secondTab));
    });
    assert.equal(mounted.current.activeTabId, secondTab);
    assert.deepEqual(mounted.current.tabs.map((tab) => tab.id), [secondTab]);
  } finally {
    await mounted.unmount();
  }
});
