import test from 'node:test';
import assert from 'node:assert/strict';

import { NoteTabStore, fromNoteTabId, isNoteTabId, toNoteTabId } from './noteTabStore';

function createStore(stored: unknown = null) {
  const state = { active: 'vault', saved: stored };
  const store = new NoteTabStore(
    { getActiveTabId: () => state.active, setActiveTabId: (id: string) => { state.active = id; } },
    { read: () => state.saved, write: (ids) => { state.saved = [...ids]; } },
  );
  return { store, state };
}

test('note tab ids round-trip and do not collide with other tab kinds', () => {
  assert.equal(toNoteTabId('abc'), 'note:abc');
  assert.equal(fromNoteTabId('note:abc'), 'abc');
  assert.equal(isNoteTabId('note:abc'), true);
  assert.equal(isNoteTabId('curl:abc'), false);
  assert.equal(isNoteTabId('vault'), false);
});

test('opening a note adds one tab and goes to it; opening it again reuses the tab', () => {
  const { store, state } = createStore();
  let changes = 0;
  store.subscribe(() => { changes += 1; });

  store.open('n1');
  store.open('n2');
  assert.deepEqual(store.getNoteIds(), ['n1', 'n2']);
  assert.equal(state.active, 'note:n2');

  store.open('n1');
  assert.deepEqual(store.getNoteIds(), ['n1', 'n2']);
  assert.equal(state.active, 'note:n1');
  assert.equal(changes, 2);

  store.open('n3', { activate: false });
  assert.equal(state.active, 'note:n1');
  assert.deepEqual(state.saved, ['n1', 'n2', 'n3']);
});

test('closing and pruning remove tabs and persist the result', () => {
  const { store, state } = createStore();
  store.open('n1');
  store.open('n2');
  store.open('n3');
  store.close('n2');
  assert.deepEqual(store.getNoteIds(), ['n1', 'n3']);
  assert.deepEqual(store.prune(new Set(['n3', 'n9'])), ['n1']);
  assert.deepEqual(store.getNoteIds(), ['n3']);
  assert.deepEqual(state.saved, ['n3']);
  assert.deepEqual(store.prune(new Set(['n3'])), []);
});

test('tabs from the last run are restored, ignoring junk', () => {
  const { store } = createStore(['a', 'a', 7, '', 'b']);
  assert.deepEqual(store.getNoteIds(), ['a', 'b']);
  assert.deepEqual(createStore({ nope: true }).store.getNoteIds(), []);
});
