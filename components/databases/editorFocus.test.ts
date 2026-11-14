import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldLeaveFocusAlone } from './editorFocus.ts';

/** An element whose ancestors match the given role (or none). */
const inside = (role: string | null) => ({
  closest: (selector: string) => (role && selector.includes(`[role="${role}"]`) ? {} : null),
});

test('the SQL editor takes the keyboard when nothing else claimed it', () => {
  assert.equal(shouldLeaveFocusAlone(null), false);
  assert.equal(shouldLeaveFocusAlone(undefined), false);
  // document.body, or a button of the page the tab was opened from.
  assert.equal(shouldLeaveFocusAlone(inside(null)), false);
});

test('focus inside a dialog, popover, menu or list stays where it is', () => {
  for (const role of ['dialog', 'alertdialog', 'menu', 'listbox']) {
    assert.equal(shouldLeaveFocusAlone(inside(role)), true, role);
  }
});

test('an element without closest() is not treated as a layer', () => {
  assert.equal(shouldLeaveFocusAlone({} as never), false);
});
