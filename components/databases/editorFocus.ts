/**
 * Layers that take the keyboard on purpose. While focus sits inside one of
 * them, a database tab coming to the front must not pull it into the editor.
 */
const FOCUS_OWNING_LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Whether focus should stay where it is when a database tab comes to the
 * front. `active` is `document.activeElement` at that moment.
 */
export function shouldLeaveFocusAlone(active: Pick<Element, 'closest'> | null | undefined): boolean {
  if (!active || typeof active.closest !== 'function') return false;
  return Boolean(active.closest(FOCUS_OWNING_LAYERS));
}
