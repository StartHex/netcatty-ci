import { tabShortcutDigitFromEvent, type KeyBinding } from './models/keyBindings';

/** Actions that only move between top tabs; they never type or edit. */
export const TAB_NAVIGATION_ACTIONS: ReadonlySet<string> = new Set(['nextTab', 'prevTab', 'switchToTab']);

/**
 * A work tab whose body is a text field of some kind — the SQL workbench, the
 * HTTP client, a note, a file editor — marks its surface with this attribute.
 *
 * Global hotkeys stay out of text fields so typing is never hijacked. For
 * those tabs that would also mean the tab-switching chords stop working the
 * moment the caret is in the editor, which is nearly always: unlike a terminal
 * tab, the tab could be switched to but not away from with the keyboard.
 * Inside a marked surface the tab-navigation chords get through (and only
 * those, and only when they type nothing: see `tabNavigationChordTypesNothing`).
 */
export const TAB_NAVIGATION_HOTKEY_SCOPE = { 'data-hotkey-tab-navigation': 'true' } as const;
const TAB_NAVIGATION_HOTKEY_SCOPE_SELECTOR = '[data-hotkey-tab-navigation="true"]';

type ChordEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & {
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
};

/**
 * Whether a chord can be taken from a text field without costing the field
 * anything.
 *
 * The usual tab chords qualify: Ctrl/Cmd with Tab, a digit, PageUp/PageDown,
 * a function key, or Shift+bracket. A chord rebound onto a key that edits or
 * moves the caret (arrows, Backspace, a letter, a bare bracket — Ctrl/Cmd+]
 * indents in the editors) stays with the field, and so does anything typed
 * through an IME or AltGr.
 */
export function tabNavigationChordTypesNothing(e: ChordEvent): boolean {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return false;
  if (!e.ctrlKey && !e.metaKey) return false;
  // AltGr reports as Ctrl+Alt on Windows layouts and produces characters.
  if (e.altKey || e.getModifierState?.('AltGraph')) return false;
  if (e.key === 'Tab' || e.key === 'PageUp' || e.key === 'PageDown') return true;
  if (/^F\d{1,2}$/.test(e.key)) return true;
  if (tabShortcutDigitFromEvent(e) !== null) return true;
  return e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight');
}

/**
 * True when the key event is a tab-navigation chord pressed inside a text
 * field of a surface that opted in, and taking it is harmless.
 */
export function isTabNavigationFromTextField(params: {
  event: ChordEvent;
  target: { closest?: (selector: string) => unknown } | null;
  keyBindings: readonly KeyBinding[];
  isMac: boolean;
  matchesKeyBinding: (event: KeyboardEvent, keyStr: string, isMac: boolean) => boolean;
}): boolean {
  const { event, target, keyBindings, isMac, matchesKeyBinding } = params;
  if (!target?.closest?.(TAB_NAVIGATION_HOTKEY_SCOPE_SELECTOR)) return false;
  if (!tabNavigationChordTypesNothing(event)) return false;
  return keyBindings.some(
    (binding) =>
      TAB_NAVIGATION_ACTIONS.has(binding.action)
      && matchesKeyBinding(event as KeyboardEvent, isMac ? binding.mac : binding.pc, isMac),
  );
}
