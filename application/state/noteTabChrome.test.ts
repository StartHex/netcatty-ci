import test from 'node:test';
import assert from 'node:assert/strict';

import { createNoteTabChromeSelector } from './noteTabChrome';

test('tab titles follow the notes and keep identity while nothing shown changes', () => {
  let ids: string[] = ['b', 'a'];
  let notes = [
    { id: 'a', title: 'Alpha', content: 'x' },
    { id: 'b', title: 'Beta', content: 'y' },
    { id: 'c', title: 'Gamma', content: 'z' },
  ];
  const select = createNoteTabChromeSelector(() => ids, () => notes);

  const first = select();
  assert.deepEqual(first, [{ id: 'b', title: 'Beta' }, { id: 'a', title: 'Alpha' }]);

  // Body edits and edits to notes without a tab change nothing the bar shows.
  notes = notes.map((note) => ({ ...note, content: `${note.content}!` }));
  notes[2] = { ...notes[2], title: 'Gamma 2' };
  assert.equal(select(), first);

  notes[0] = { ...notes[0], title: 'Alpha 2' };
  const retitled = select();
  assert.notEqual(retitled, first);
  assert.deepEqual(retitled[1], { id: 'a', title: 'Alpha 2' });

  ids = ['b', 'a', 'gone'];
  assert.deepEqual(select()[2], { id: 'gone', title: '' });
  ids = [];
  assert.deepEqual(select(), []);
});
