import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseTabRoster } from './databaseTabRoster.ts';

test('a tab opened and closed in the same tick is known without waiting for a render', () => {
  const roster = new DatabaseTabRoster();
  roster.add('tab_1', 'conn_a');
  assert.equal(roster.has('tab_1'), true);
  assert.equal(roster.connectionOf('tab_1'), 'conn_a');
  assert.equal(roster.findByConnection('conn_a'), 'tab_1');

  assert.equal(roster.remove('tab_1'), true);
  assert.equal(roster.has('tab_1'), false);
  assert.equal(roster.findByConnection('conn_a'), undefined);
  assert.equal(roster.remove('tab_1'), false, 'a second close of the same tab is a no-op');
});

test('closing every tab of a connection back to back leaves the connection unused', () => {
  const roster = new DatabaseTabRoster();
  roster.add('tab_1', 'conn_a');
  roster.add('tab_2', 'conn_a');
  roster.add('tab_3', 'conn_b');

  // "Close all" closes tab_1 and tab_2 before any render: the first close must
  // see its sibling, the second must not see the tab that just went away.
  roster.remove('tab_1');
  assert.equal(roster.isConnectionInUse('conn_a'), true);
  assert.equal(roster.isConnectionInUse('conn_a', 'tab_2'), false);
  roster.remove('tab_2');
  assert.equal(roster.isConnectionInUse('conn_a'), false);
  assert.equal(roster.isConnectionInUse('conn_b'), true);
});

test('the tab found for a connection is the first one in tab order', () => {
  const roster = new DatabaseTabRoster();
  roster.reset([
    { id: 'tab_1', connectionId: 'conn_a' },
    { id: 'tab_2', connectionId: 'conn_b' },
    { id: 'tab_3', connectionId: 'conn_a' },
  ]);
  assert.equal(roster.findByConnection('conn_a'), 'tab_1');
  roster.remove('tab_1');
  assert.equal(roster.findByConnection('conn_a'), 'tab_3');
  assert.equal(roster.findByConnection('conn_missing'), undefined);
});

test('restoring replaces whatever was tracked before', () => {
  const roster = new DatabaseTabRoster();
  roster.add('stale', 'conn_old');
  roster.reset([{ id: 'tab_1', connectionId: 'conn_a' }]);
  assert.equal(roster.has('stale'), false);
  assert.equal(roster.has('tab_1'), true);
});
