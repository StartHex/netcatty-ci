import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_KEY_BINDINGS, matchesKeyBinding } from './models/keyBindings.ts';
import {
  TAB_NAVIGATION_ACTIONS,
  TAB_NAVIGATION_HOTKEY_SCOPE,
  isTabNavigationFromTextField,
  tabNavigationChordTypesNothing,
} from './tabNavigationHotkeys.ts';

type Chord = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
};

const chord = (init: Chord) => ({
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

/** An element inside a surface that opted in to tab navigation. */
const inScope = { closest: (selector: string) => (selector.includes('data-hotkey-tab-navigation') ? {} : null) };
/** An element anywhere else (the vault search box, a dialog field...). */
const outOfScope = { closest: () => null };

const fromTextField = (event: ReturnType<typeof chord>, target: { closest: (selector: string) => unknown }, isMac = false) =>
  isTabNavigationFromTextField({
    event,
    target,
    keyBindings: DEFAULT_KEY_BINDINGS,
    isMac,
    matchesKeyBinding,
  });

test('the scope marker is the attribute the hotkey handler looks for', () => {
  assert.deepEqual(TAB_NAVIGATION_HOTKEY_SCOPE, { 'data-hotkey-tab-navigation': 'true' });
  assert.deepEqual([...TAB_NAVIGATION_ACTIONS].sort(), ['nextTab', 'prevTab', 'switchToTab']);
});

test('the default tab chords can be taken from a text field', () => {
  // Windows / Linux defaults.
  assert.equal(tabNavigationChordTypesNothing(chord({ key: 'Tab', code: 'Tab', ctrlKey: true })), true);
  assert.equal(tabNavigationChordTypesNothing(chord({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })), true);
  assert.equal(tabNavigationChordTypesNothing(chord({ key: '3', code: 'Digit3', ctrlKey: true })), true);
  // macOS defaults.
  assert.equal(tabNavigationChordTypesNothing(chord({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })), true);
  assert.equal(tabNavigationChordTypesNothing(chord({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true })), true);
  assert.equal(tabNavigationChordTypesNothing(chord({ key: '9', code: 'Digit9', metaKey: true })), true);
  // Common rebinds.
  assert.equal(tabNavigationChordTypesNothing(chord({ key: 'PageDown', code: 'PageDown', ctrlKey: true })), true);
  assert.equal(tabNavigationChordTypesNothing(chord({ key: 'F6', code: 'F6', ctrlKey: true })), true);
});

test('a chord that edits or types stays with the text field', () => {
  // No command modifier: plain typing.
  assert.equal(tabNavigationChordTypesNothing(chord({ key: 'Tab', code: 'Tab' })), false);
  assert.equal(tabNavigationChordTypesNothing(chord({ key: '1', code: 'Digit1' })), false);
  // Caret movement, deleting, running the statement.
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete', 'Enter', ' ']) {
    assert.equal(tabNavigationChordTypesNothing(chord({ key, ctrlKey: true })), false, `Ctrl+${key}`);
  }
  // Clipboard, undo, select all, find... and any other letter.
  for (const key of ['a', 'c', 'v', 'x', 'z', 'w', 'f', 'ф']) {
    assert.equal(tabNavigationChordTypesNothing(chord({ key, ctrlKey: true })), false, `Ctrl+${key}`);
  }
  // Ctrl/Cmd+] indents the line in the editors.
  assert.equal(tabNavigationChordTypesNothing(chord({ key: ']', code: 'BracketRight', ctrlKey: true })), false);
  assert.equal(tabNavigationChordTypesNothing(chord({ key: ']', code: 'BracketRight', metaKey: true })), false);
});

test('IME composition and AltGr input are never taken', () => {
  assert.equal(
    tabNavigationChordTypesNothing(chord({ key: '1', code: 'Digit1', ctrlKey: true, isComposing: true })),
    false,
  );
  assert.equal(
    tabNavigationChordTypesNothing(chord({ key: 'Process', code: 'Digit1', ctrlKey: true, keyCode: 229 })),
    false,
  );
  // AltGr+7 types "{" on a German layout and reports Ctrl+Alt.
  assert.equal(
    tabNavigationChordTypesNothing(chord({ key: '{', code: 'Digit7', ctrlKey: true, altKey: true })),
    false,
  );
  assert.equal(
    tabNavigationChordTypesNothing(
      chord({ key: '{', code: 'Digit7', ctrlKey: true, getModifierState: (name) => name === 'AltGraph' }),
    ),
    false,
  );
});

test('tab chords get through only inside a surface that opted in', () => {
  const nextTab = chord({ key: 'Tab', code: 'Tab', ctrlKey: true });
  const thirdTab = chord({ key: '3', code: 'Digit3', ctrlKey: true });
  assert.equal(fromTextField(nextTab, inScope), true);
  assert.equal(fromTextField(thirdTab, inScope), true);
  assert.equal(fromTextField(nextTab, outOfScope), false);
  assert.equal(fromTextField(thirdTab, outOfScope), false);

  // The stored macOS chord is "⌘ + Shift + ]"; the binding matcher compares the
  // reported key, the text-field rule goes by the physical bracket key.
  const macNext = chord({ key: ']', code: 'BracketRight', metaKey: true, shiftKey: true });
  assert.equal(matchesKeyBinding(macNext as KeyboardEvent, '⌘ + Shift + ]', true), true);
  assert.equal(fromTextField(macNext, inScope, true), true);
  assert.equal(fromTextField(macNext, outOfScope, true), false);
});

test('other shortcuts do not ride along, even inside the surface', () => {
  // Close tab: Ctrl+W deletes a word in a shell, and a database tab has no
  // unsaved-changes prompt.
  assert.equal(fromTextField(chord({ key: 'w', code: 'KeyW', ctrlKey: true }), inScope), false);
  // New local terminal.
  assert.equal(fromTextField(chord({ key: 't', code: 'KeyT', ctrlKey: true }), inScope), false);
  // A chord nothing is bound to.
  assert.equal(fromTextField(chord({ key: 'F9', code: 'F9', ctrlKey: true }), inScope), false);
});

test('a tab chord rebound onto an editing key keeps its text meaning in the field', () => {
  const rebound = DEFAULT_KEY_BINDINGS.map((binding) =>
    binding.action === 'nextTab' ? { ...binding, pc: 'Ctrl + →' } : binding,
  );
  const event = chord({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
  assert.equal(matchesKeyBinding(event as KeyboardEvent, 'Ctrl + →', false), true, 'the rebind itself is valid');
  assert.equal(
    isTabNavigationFromTextField({
      event,
      target: inScope,
      keyBindings: rebound,
      isMac: false,
      matchesKeyBinding,
    }),
    false,
    'Ctrl+Right still moves by a word in the editor',
  );
});

test('a missing target is not a text field', () => {
  assert.equal(
    isTabNavigationFromTextField({
      event: chord({ key: 'Tab', code: 'Tab', ctrlKey: true }),
      target: null,
      keyBindings: DEFAULT_KEY_BINDINGS,
      isMac: false,
      matchesKeyBinding,
    }),
    false,
  );
});
