import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  executeHotkeyActionImpl,
  getLogHostVisualSnapshot,
  handleEscapeKeyDownImpl,
  handleGlobalHotkeyKeyDownImpl,
  markForwardedNativeShortcutEvent,
} from './app/AppHandlers.ts';
import {
  DEFAULT_SETTINGS_CHROME_SNAPSHOT,
  getSettingsChromeSnapshot,
  publishSettingsChromeSnapshot,
} from './state/settingsChromeStore.ts';
import { matchesKeyBinding } from '../domain/models.ts';
import { DEFAULT_KEY_BINDINGS } from '../domain/models/keyBindings.ts';

class FakeInputHTMLElement {
  tagName = 'INPUT';
  isContentEditable = false;

  closest(): FakeInputHTMLElement | null {
    return null;
  }
}

class FakeHTMLElement {
  tagName = 'TEXTAREA';
  isContentEditable = false;
  classList = {
    contains: (className: string) => className === 'xterm-helper-textarea',
  };

  closest(selector: string): FakeHTMLElement | null {
    return selector.includes('xterm') ? this : null;
  }

  hasAttribute(name: string): boolean {
    return name === 'data-session-id';
  }
}

class FakeMonacoHTMLElement extends FakeHTMLElement {
  tagName = 'TEXTAREA';

  closest(selector: string): FakeMonacoHTMLElement | null {
    return selector.includes('monaco') ? this : null;
  }
}

/** The SQL / file editor of a work tab whose surface opted in to tab navigation. */
class FakeWorkTabMonacoHTMLElement extends FakeHTMLElement {
  tagName = 'TEXTAREA';

  closest(selector: string): FakeWorkTabMonacoHTMLElement | null {
    return selector.includes('monaco') || selector.includes('data-hotkey-tab-navigation') ? this : null;
  }
}

/** A plain input of such a tab (a table filter, the request URL of the HTTP client). */
class FakeWorkTabInputHTMLElement {
  tagName = 'INPUT';
  isContentEditable = false;

  closest(selector: string): FakeWorkTabInputHTMLElement | null {
    return selector.includes('data-hotkey-tab-navigation') ? this : null;
  }
}

const previousHTMLElement = globalThis.HTMLElement;
globalThis.HTMLElement = FakeHTMLElement as unknown as typeof HTMLElement;

test.after(() => {
  globalThis.HTMLElement = previousHTMLElement;
});

test('global hotkey handler lets terminal font size shortcuts reach xterm', () => {
  const target = new FakeHTMLElement();
  const handledActions: string[] = [];
  let prevented = false;
  let stopped = false;
  const event = {
    key: '=',
    code: 'Equal',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, []);
  assert.equal(prevented, false);
  assert.equal(stopped, false);
});

test('global hotkey handler routes quick switch through focused search inputs', () => {
  const target = new FakeInputHTMLElement();
  const handledActions: string[] = [];
  const event = {
    key: 'j',
    code: 'KeyJ',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, ['quickSwitch']);
});

test('global hotkey handler magnifies panes from focused form inputs', () => {
  const target = new FakeInputHTMLElement();
  const handledActions: string[] = [];
  const event = {
    key: 'm',
    code: 'KeyM',
    ctrlKey: false,
    metaKey: false,
    altKey: true,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, ['togglePaneZoom']);
});

test('forwarded native shortcut can run a reassigned global action from Monaco', () => {
  const target = new FakeMonacoHTMLElement();
  const handledActions: string[] = [];
  let prevented = false;
  const event = markForwardedNativeShortcutEvent({
    key: 'w',
    code: 'KeyW',
    ctrlKey: false,
    metaKey: true,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  } as unknown as KeyboardEvent);
  const keyBindings = DEFAULT_KEY_BINDINGS.map((binding) => {
    if (binding.action === 'closeTab') return { ...binding, mac: 'Disabled' };
    if (binding.action === 'newTab') return { ...binding, mac: '⌘ + W' };
    return binding;
  });

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Disabled',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'mac',
      keyBindings,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, ['newTab']);
  assert.equal(prevented, true);
});

test('quick switch hotkey toggles the quick switcher open state', () => {
  let isQuickSwitcherOpen = false;
  const setIsQuickSwitcherOpen = (next: boolean) => {
    isQuickSwitcherOpen = next;
  };
  const noop = () => {};
  const baseCtx = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => 'vault' },
    addConnectionLogRef: { current: noop },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isQuickSwitcherOpen,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    workspaces: [],
  };

  const event = {
    key: 'j',
    code: 'KeyJ',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  } as KeyboardEvent;

  executeHotkeyActionImpl(() => baseCtx, 'quickSwitch', event);
  assert.equal(isQuickSwitcherOpen, true);

  executeHotkeyActionImpl(() => ({ ...baseCtx, isQuickSwitcherOpen: true }), 'quickSwitch', event);
  assert.equal(isQuickSwitcherOpen, false);
});

test('pane zoom hotkey delegates to the active in-app magnification surface', () => {
  let toggles = 0;
  const noop = () => {};
  const controller = {
    getState: () => 'focusable' as const,
    focus: () => false,
    restore: () => false,
    toggle: () => {
      toggles += 1;
      return true;
    },
  };

  executeHotkeyActionImpl(() => ({
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => 'workspace-1' },
    addConnectionLogRef: { current: noop },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    sftpPaneMagnificationRef: { current: null },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    terminalPaneMagnificationRef: { current: controller },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  }), 'togglePaneZoom', {} as KeyboardEvent);

  assert.equal(toggles, 1);
});

test('broadcast hotkey toggles global mode for an active orphan tab', () => {
  let globalToggles = 0;
  let workspaceToggles = 0;

  executeHotkeyActionImpl(() => ({
    activeTabStore: { getActiveTabId: () => 'orphan-1' },
    editorTabs: [],
    orderedTabs: ['orphan-1', 'orphan-2'],
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    toEditorTabId: (id: string) => id,
    sessions: [
      { id: 'orphan-1' },
      { id: 'orphan-2' },
    ],
    workspaces: [],
    canUseGlobalBroadcast: true,
    toggleBroadcast: () => { workspaceToggles += 1; },
    toggleGlobalBroadcast: () => { globalToggles += 1; },
  }), 'broadcast', {} as KeyboardEvent);

  assert.equal(globalToggles, 1);
  assert.equal(workspaceToggles, 0);
});

test('move-focus shortcut cannot send input behind a magnified pane', () => {
  let moveCalls = 0;
  executeHotkeyActionImpl(() => ({
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => 'workspace-1' },
    editorTabs: [],
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: () => {
      moveCalls += 1;
      return true;
    },
    orderedTabs: [],
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    sftpPaneMagnificationRef: { current: null },
    terminalPaneMagnificationRef: {
      current: {
        getState: () => 'focused' as const,
        focus: () => false,
        restore: () => true,
        toggle: () => true,
      },
    },
    toEditorTabId: (id: string) => `editor:${id}`,
    workspaces: [{ id: 'workspace-1', title: 'Workspace' }],
  }), 'moveFocus', {
    key: 'ArrowRight',
  } as KeyboardEvent);

  assert.equal(moveCalls, 0);
});

test('Escape leaves magnification unchanged and reaches the terminal', () => {
  let restores = 0;
  let prevented = false;
  let stopped = false;
  const event = {
    key: 'Escape',
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  } as unknown as KeyboardEvent;

  handleEscapeKeyDownImpl(() => ({
    isQuickSwitcherOpen: false,
    setIsQuickSwitcherOpen: () => {},
    sftpPaneMagnificationRef: { current: null },
    terminalPaneMagnificationRef: {
      current: {
        getState: () => 'focused',
        focus: () => false,
        restore: () => {
          restores += 1;
          return true;
        },
        toggle: () => false,
      },
    },
  }), event);

  assert.equal(restores, 0);
  assert.equal(prevented, false);
  assert.equal(stopped, false);
});

test('Escape closes the quick switcher', () => {
  let open = true;
  handleEscapeKeyDownImpl(() => ({
    isQuickSwitcherOpen: open,
    setIsQuickSwitcherOpen: (value: boolean) => { open = value; },
  }), { key: 'Escape', defaultPrevented: false } as KeyboardEvent);

  assert.equal(open, false);
});

test('consumed Escape leaves the quick switcher open', () => {
  let open = true;
  handleEscapeKeyDownImpl(() => ({
    isQuickSwitcherOpen: open,
    setIsQuickSwitcherOpen: (value: boolean) => { open = value; },
  }), { key: 'Escape', defaultPrevented: true } as KeyboardEvent);

  assert.equal(open, true);
});

test('close tab hotkey routes native plugin view tabs through their owner', () => {
  let closedTabId = '';
  const pluginTabId = 'plugin-view:com.example.view:com.example.view.panel';
  const noop = () => {};

  executeHotkeyActionImpl(() => ({
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => pluginTabId },
    addConnectionLogRef: { current: noop },
    closePluginViewTab: (tabId: string) => { closedTabId = tabId; },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isPluginViewTabId: (tabId: string) => tabId.startsWith('plugin-view:'),
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [pluginTabId],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  }), 'closeTab', { key: 'w', metaKey: true } as KeyboardEvent);

  assert.equal(closedTabId, pluginTabId);
});

test('next, previous, and number shortcuts include native plugin view tabs', () => {
  const pluginTabId = 'plugin-view:com.example.view:com.example.view.panel';
  let activeTabId = 'session-1';
  const selected: string[] = [];
  const noop = () => {};
  const context = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => activeTabId },
    addConnectionLogRef: { current: noop },
    closePluginViewTab: noop,
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isPluginViewTabId: (tabId: string) => tabId.startsWith('plugin-view:'),
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: ['session-1', pluginTabId, 'session-2'],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: (id: string) => { activeTabId = id; selected.push(id); },
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: false, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  };

  executeHotkeyActionImpl(() => context, 'nextTab', { key: 'Tab', ctrlKey: true } as KeyboardEvent);
  assert.equal(activeTabId, pluginTabId);
  executeHotkeyActionImpl(() => context, 'prevTab', { key: 'Tab', ctrlKey: true, shiftKey: true } as KeyboardEvent);
  assert.equal(activeTabId, 'session-1');
  executeHotkeyActionImpl(() => context, 'switchToTab', { key: '3', metaKey: true } as KeyboardEvent);
  assert.equal(activeTabId, pluginTabId);
  assert.deepEqual(selected, [pluginTabId, 'session-1', pluginTabId]);
});

test('switchToTab uses physical Digit code when Shift remaps e.key', () => {
  let activeTabId = 'session-1';
  const noop = () => {};
  const context = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => activeTabId },
    addConnectionLogRef: { current: noop },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: ['session-1', 'session-2', 'session-3'],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: (id: string) => { activeTabId = id; },
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: false, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  };

  executeHotkeyActionImpl(
    () => context,
    'switchToTab',
    { key: '@', code: 'Digit3', ctrlKey: true, shiftKey: true } as KeyboardEvent,
  );
  assert.equal(activeTabId, 'session-2');
});

test('next tab includes pinned tabs when shell-only shortcut mode is disabled', () => {
  let activeTabId = '';
  const noop = () => {};

  executeHotkeyActionImpl(
    () => ({
      IS_DEV: false,
      MOVE_FOCUS_DEBOUNCE_MS: 0,
      activeTabStore: { getActiveTabId: () => 'vault' },
      addConnectionLogRef: { current: noop },
      closeSession: noop,
      closeTabInFlightRef: { current: false },
      closeWorkspace: noop,
      collectSessionIds: () => [],
      confirmIfBusyLocalTerminal: async () => true,
      createLocalTerminalWithCurrentShell: noop,
      editorTabs: [{ id: 'editor-1' }],
      fromEditorTabId: () => null,
      handleOpenSettingsRef: { current: noop },
      handleRequestCloseEditorTabRef: { current: noop },
      isEditorTabId: () => false,
      isQuickSwitcherOpen: false,
      lastMoveFocusTimeRef: { current: 0 },
      moveFocusInWorkspace: noop,
      orderedTabs: ['session-1'],
      resolveCloseIntent: () => ({ kind: 'noop' }),
      resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
      sessions: [],
      setActiveTabId: (id: string) => { activeTabId = id; },
      setAddToWorkspaceDialog: noop,
      setIsQuickSwitcherOpen: noop,
      setNavigateToSection: noop,
      settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
      splitSessionWithCurrentShell: noop,
      systemInfoRef: { current: { username: 'user', hostname: 'host' } },
      toEditorTabId: (id: string) => `editor:${id}`,
      toggleBroadcast: noop,
      toggleScriptsSidePanelRef: { current: noop },
      toggleSidePanelRef: { current: noop },
      toggleWorkspaceViewMode: noop,
      workspaces: [],
    }),
    'nextTab',
    { key: 'Tab', ctrlKey: true } as KeyboardEvent,
  );

  assert.equal(activeTabId, 'sftp');
});

test('next tab skips pinned tabs when shell-only shortcut mode is enabled', () => {
  let activeTabId = '';
  const noop = () => {};

  executeHotkeyActionImpl(
    () => ({
      IS_DEV: false,
      MOVE_FOCUS_DEBOUNCE_MS: 0,
      activeTabStore: { getActiveTabId: () => 'vault' },
      addConnectionLogRef: { current: noop },
      closeSession: noop,
      closeTabInFlightRef: { current: false },
      closeWorkspace: noop,
      collectSessionIds: () => [],
      confirmIfBusyLocalTerminal: async () => true,
      createLocalTerminalWithCurrentShell: noop,
      editorTabs: [{ id: 'editor-1' }],
      fromEditorTabId: () => null,
      handleOpenSettingsRef: { current: noop },
      handleRequestCloseEditorTabRef: { current: noop },
      isEditorTabId: () => false,
      isQuickSwitcherOpen: false,
      lastMoveFocusTimeRef: { current: 0 },
      moveFocusInWorkspace: noop,
      orderedTabs: ['session-1'],
      resolveCloseIntent: () => ({ kind: 'noop' }),
      resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
      sessions: [],
      setActiveTabId: (id: string) => { activeTabId = id; },
      setAddToWorkspaceDialog: noop,
      setIsQuickSwitcherOpen: noop,
      setNavigateToSection: noop,
      settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: true },
      splitSessionWithCurrentShell: noop,
      systemInfoRef: { current: { username: 'user', hostname: 'host' } },
      toEditorTabId: (id: string) => `editor:${id}`,
      toggleBroadcast: noop,
      toggleScriptsSidePanelRef: { current: noop },
      toggleSidePanelRef: { current: noop },
      toggleWorkspaceViewMode: noop,
      workspaces: [],
    }),
    'nextTab',
    { key: 'Tab', ctrlKey: true } as KeyboardEvent,
  );

  assert.equal(activeTabId, 'session-1');
});

test('connection log host snapshot includes custom host icon fields', () => {
  assert.deepEqual(
    getLogHostVisualSnapshot({
      id: 'host-1',
      label: 'Database',
      hostname: 'db.example.com',
      username: 'root',
      tags: [],
      os: 'linux',
      distro: 'ubuntu',
      iconMode: 'custom',
      iconId: 'database',
      iconColor: 'blue',
    }),
    {
      hostOs: 'linux',
      hostDistro: 'ubuntu',
      hostIconMode: 'custom',
      hostIconId: 'database',
      hostIconColorMode: 'manual',
      hostIconColor: 'blue',
    },
  );
});

test('toggleOpacity hotkey invokes toggleWindowOpacity', () => {
  let called = false;
  const noop = () => {};

  executeHotkeyActionImpl(
    () => ({
      IS_DEV: false,
      MOVE_FOCUS_DEBOUNCE_MS: 0,
      activeTabStore: { getActiveTabId: () => 'vault' },
      addConnectionLogRef: { current: noop },
      closeSession: noop,
      closeTabInFlightRef: { current: false },
      closeWorkspace: noop,
      collectSessionIds: () => [],
      confirmIfBusyLocalTerminal: async () => true,
      createLocalTerminalWithCurrentShell: noop,
      editorTabs: [],
      fromEditorTabId: () => null,
      handleOpenSettingsRef: { current: noop },
      handleRequestCloseEditorTabRef: { current: noop },
      isEditorTabId: () => false,
      isQuickSwitcherOpen: false,
      lastMoveFocusTimeRef: { current: 0 },
      moveFocusInWorkspace: noop,
      orderedTabs: [],
      resolveCloseIntent: () => ({ kind: 'noop' }),
      resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
      sessions: [],
      setActiveTabId: noop,
      setAddToWorkspaceDialog: noop,
      setIsQuickSwitcherOpen: noop,
      setNavigateToSection: noop,
      settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
      splitSessionWithCurrentShell: noop,
      systemInfoRef: { current: { username: 'user', hostname: 'host' } },
      toEditorTabId: (id: string) => `editor:${id}`,
      toggleBroadcast: noop,
      toggleScriptsSidePanelRef: { current: noop },
      toggleSidePanelRef: { current: noop },
      toggleWindowOpacity: () => { called = true; },
      toggleWorkspaceViewMode: noop,
      workspaces: [],
    }),
    'toggleOpacity',
    { key: 'u', code: 'KeyU', ctrlKey: true, shiftKey: true } as KeyboardEvent,
  );

  assert.equal(called, true);
});

for (const scenario of [
  { name: 'IME process key with its original physical code', key: 'Process', keyCode: 229, isComposing: false, expected: false },
  { name: 'key during composition', key: 'U', keyCode: 85, isComposing: true, expected: false },
  { name: 'ordinary shortcut', key: 'U', keyCode: 85, isComposing: false, expected: true },
]) {
  test(`transparency shortcut respects ${scenario.name}`, () => {
    const target = new FakeHTMLElement();
    const actions: string[] = [];
    let prevented = false;
    const event = {
      ...scenario,
      code: 'KeyU',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      target,
      composedPath: () => [target],
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    } as unknown as KeyboardEvent;
    handleGlobalHotkeyKeyDownImpl(() => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => actions.push(action),
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }), event);
    assert.deepEqual(actions, scenario.expected ? ['toggleOpacity'] : []);
    assert.equal(prevented, scenario.expected);
  });
}
for (const scenario of [
  { name: 'single orphan', active: 'one', sessions: [{ id: 'one' }], available: false, expected: null },
  { name: 'two orphans', active: 'one', sessions: [{ id: 'one' }, { id: 'two' }], available: true, expected: 'global' },
  { name: 'hidden active session', active: 'hidden', sessions: [{ id: 'one' }, { id: 'two' }, { id: 'hidden', hiddenFromTabs: true }], available: true, expected: null },
  { name: 'non-terminal tab', active: 'vault', sessions: [{ id: 'one' }, { id: 'two' }], available: true, expected: null },
  { name: 'workspace', active: 'workspace', sessions: [{ id: 'one', workspaceId: 'workspace' }, { id: 'two', workspaceId: 'workspace' }], available: false, expected: 'workspace' },
]) {
  for (const scheme of ['pc', 'mac'] as const) {
    test(`broadcast shortcut ${scheme}: ${scenario.name} only consumes an executed toggle`, () => {
      const target = new FakeHTMLElement();
      let prevented = 0;
      let stopped = 0;
      let globalEnabled = false;
      let workspaceEnabled = false;
      const toggles: string[] = [];
      const event = {
        key: 'b', code: 'KeyB', ctrlKey: scheme === 'pc', metaKey: scheme === 'mac',
        altKey: false, shiftKey: false, target, composedPath: () => [target],
        preventDefault: () => { prevented += 1; },
        stopPropagation: () => { stopped += 1; },
      } as unknown as KeyboardEvent;
      const actionCtx = {
        activeTabStore: { getActiveTabId: () => scenario.active },
        editorTabs: [], orderedTabs: [], settings: {}, toEditorTabId: (id: string) => id,
        sessions: scenario.sessions,
        workspaces: scenario.active === 'workspace' ? [{ id: 'workspace' }] : [],
        canUseGlobalBroadcast: scenario.available,
        toggleGlobalBroadcast: () => { globalEnabled = !globalEnabled; toggles.push('global'); },
        toggleBroadcast: (id: string) => { assert.equal(id, 'workspace'); workspaceEnabled = !workspaceEnabled; toggles.push('workspace'); },
      };
      const invoke = () => handleGlobalHotkeyKeyDownImpl(() => ({
        HOTKEY_DEBUG: false, closeTabKeyStr: '', hotkeyScheme: scheme,
        keyBindings: DEFAULT_KEY_BINDINGS, matchesKeyBinding,
        executeHotkeyAction: (action: string, e: KeyboardEvent) => executeHotkeyActionImpl(() => actionCtx, action, e),
      }), event);
      invoke();
      assert.equal(globalEnabled, scenario.expected === 'global');
      assert.equal(workspaceEnabled, scenario.expected === 'workspace');
      invoke();
      assert.equal(globalEnabled, false);
      assert.equal(workspaceEnabled, false);
      assert.deepEqual(toggles, scenario.expected ? [scenario.expected, scenario.expected] : []);
      assert.equal(prevented, scenario.expected ? 2 : 0);
      assert.equal(stopped, scenario.expected ? 2 : 0);
    });
  }
}

for (const scheme of ['pc', 'mac'] as const) {
  test(`focused terminal ${scheme} consumes Shift+B for the host list and leaves plain B to broadcast`, () => {
    const target = new FakeHTMLElement();
    const shiftedActions: string[] = [];
    let shiftedPrevented = false;
    let shiftedStopped = false;
    handleGlobalHotkeyKeyDownImpl(() => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: '',
      executeHotkeyAction: (action: string) => {
        shiftedActions.push(action);
        return action === 'toggleHostTree';
      },
      hotkeyScheme: scheme,
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }), {
      key: 'b',
      code: 'KeyB',
      ctrlKey: scheme === 'pc',
      metaKey: scheme === 'mac',
      altKey: false,
      shiftKey: true,
      target,
      composedPath: () => [target],
      preventDefault: () => { shiftedPrevented = true; },
      stopPropagation: () => { shiftedStopped = true; },
    } as unknown as KeyboardEvent);

    assert.deepEqual(shiftedActions, ['toggleHostTree']);
    assert.equal(shiftedPrevented, true);
    assert.equal(shiftedStopped, true);

    const plainActions: string[] = [];
    let plainPrevented = false;
    handleGlobalHotkeyKeyDownImpl(() => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: '',
      executeHotkeyAction: (action: string) => {
        plainActions.push(action);
        return undefined;
      },
      hotkeyScheme: scheme,
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }), {
      key: 'b',
      code: 'KeyB',
      ctrlKey: scheme === 'pc',
      metaKey: scheme === 'mac',
      altKey: false,
      shiftKey: false,
      target,
      composedPath: () => [target],
      preventDefault: () => { plainPrevented = true; },
      stopPropagation: () => {},
    } as unknown as KeyboardEvent);

    assert.deepEqual(plainActions, ['broadcast']);
    assert.equal(plainPrevented, false);
  });
}

test('focused terminal leaves the host-list chord alone when the toggle does not run', () => {
  const target = new FakeHTMLElement();
  const actions: string[] = [];
  let prevented = false;
  let stopped = false;
  handleGlobalHotkeyKeyDownImpl(() => ({
    HOTKEY_DEBUG: false,
    closeTabKeyStr: '',
    executeHotkeyAction: (action: string) => {
      actions.push(action);
      return false;
    },
    hotkeyScheme: 'pc',
    keyBindings: DEFAULT_KEY_BINDINGS,
    matchesKeyBinding,
  }), {
    key: 'b',
    code: 'KeyB',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    target,
    composedPath: () => [target],
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  } as unknown as KeyboardEvent);

  assert.deepEqual(actions, ['toggleHostTree']);
  assert.equal(prevented, false);
  assert.equal(stopped, false);
});

test('host list shortcut reaches a focused Monaco editor and stays out of plain text fields', () => {
  const monaco = new FakeMonacoHTMLElement();
  const monacoActions: string[] = [];
  let monacoPrevented = false;
  handleGlobalHotkeyKeyDownImpl(() => ({
    HOTKEY_DEBUG: false,
    closeTabKeyStr: '',
    executeHotkeyAction: (action: string) => {
      monacoActions.push(action);
      return true;
    },
    hotkeyScheme: 'pc',
    keyBindings: DEFAULT_KEY_BINDINGS,
    matchesKeyBinding,
  }), {
    key: 'b',
    code: 'KeyB',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    target: monaco,
    composedPath: () => [monaco],
    preventDefault: () => { monacoPrevented = true; },
    stopPropagation: () => {},
  } as unknown as KeyboardEvent);

  assert.deepEqual(monacoActions, ['toggleHostTree']);
  assert.equal(monacoPrevented, true);

  const input = new FakeInputHTMLElement();
  const inputActions: string[] = [];
  let inputPrevented = false;
  handleGlobalHotkeyKeyDownImpl(() => ({
    HOTKEY_DEBUG: false,
    closeTabKeyStr: '',
    executeHotkeyAction: (action: string) => {
      inputActions.push(action);
      return true;
    },
    hotkeyScheme: 'pc',
    keyBindings: DEFAULT_KEY_BINDINGS,
    matchesKeyBinding,
  }), {
    key: 'b',
    code: 'KeyB',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    target: input,
    composedPath: () => [input],
    preventDefault: () => { inputPrevented = true; },
    stopPropagation: () => {},
  } as unknown as KeyboardEvent);

  assert.deepEqual(inputActions, []);
  assert.equal(inputPrevented, false);
});

test('toggleHostTree uses the host list toggle only while that list can show', () => {
  const previous = getSettingsChromeSnapshot();
  const calls: string[] = [];
  const toggleHostTree = () => { calls.push('toggle'); };
  const event = {} as KeyboardEvent;
  const contextFor = (activeTabId: string, orderedTabs: string[] = [activeTabId]) => ({
    activeTabStore: { getActiveTabId: () => activeTabId },
    editorTabs: [],
    orderedTabs,
    sessions: [{ id: 'session-1' }],
    settings: {},
    toEditorTabId: (id: string) => id,
    toggleHostTree,
    workspaces: [{ id: 'workspace-1' }],
  });

  try {
    publishSettingsChromeSnapshot({ ...DEFAULT_SETTINGS_CHROME_SNAPSHOT, showHostTreeSidebar: true });
    assert.equal(executeHotkeyActionImpl(() => contextFor('session-1'), 'toggleHostTree', event), true);
    assert.equal(executeHotkeyActionImpl(() => contextFor('editor:note', []), 'toggleHostTree', event), true);
    assert.equal(executeHotkeyActionImpl(() => contextFor('workspace-1'), 'toggleHostTree', event), true);
    assert.deepEqual(calls, ['toggle', 'toggle', 'toggle']);

    calls.length = 0;
    assert.equal(executeHotkeyActionImpl(() => contextFor('vault', []), 'toggleHostTree', event), false);
    assert.equal(executeHotkeyActionImpl(() => contextFor('sftp', []), 'toggleHostTree', event), false);
    assert.equal(executeHotkeyActionImpl(() => contextFor('plugin-view:demo:main', ['plugin-view:demo:main']), 'toggleHostTree', event), false);
    assert.deepEqual(calls, []);

    publishSettingsChromeSnapshot({ ...DEFAULT_SETTINGS_CHROME_SNAPSHOT, showHostTreeSidebar: false });
    assert.equal(executeHotkeyActionImpl(() => contextFor('session-1'), 'toggleHostTree', event), false);
    assert.deepEqual(calls, []);
  } finally {
    publishSettingsChromeSnapshot(previous);
  }
});

test('host list shortcut calls the same store toggle as the toolbar button', () => {
  const source = readFileSync(new URL('./app/AppSideEffects.tsx', import.meta.url), 'utf8');
  assert.match(source, /toggleHostTree:\s*\(\)\s*=>\s*terminalHostTreeStore\.toggle\(\)/);
});

function pressFromTarget(
  target: object,
  init: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean },
  options: { hotkeyScheme?: 'pc' | 'mac'; keyBindings?: typeof DEFAULT_KEY_BINDINGS } = {},
) {
  const actions: string[] = [];
  let prevented = false;
  let stopped = false;
  handleGlobalHotkeyKeyDownImpl(() => ({
    HOTKEY_DEBUG: false,
    closeTabKeyStr: options.hotkeyScheme === 'mac' ? '⌘ + W' : 'Ctrl + W',
    executeHotkeyAction: (action: string) => {
      actions.push(action);
      return true;
    },
    hotkeyScheme: options.hotkeyScheme ?? 'pc',
    keyBindings: options.keyBindings ?? DEFAULT_KEY_BINDINGS,
    matchesKeyBinding,
  }), {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
    target,
    composedPath: () => [target],
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  } as unknown as KeyboardEvent);
  return { actions, prevented, stopped };
}

test('tab switching works while typing in a database, curl, note or file-editor tab', () => {
  for (const target of [new FakeWorkTabMonacoHTMLElement(), new FakeWorkTabInputHTMLElement()]) {
    const next = pressFromTarget(target, { key: 'Tab', code: 'Tab', ctrlKey: true });
    assert.deepEqual(next.actions, ['nextTab']);
    assert.equal(next.prevented, true, 'the editor must not also act on the chord');
    assert.equal(next.stopped, true);

    assert.deepEqual(
      pressFromTarget(target, { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }).actions,
      ['prevTab'],
    );
    assert.deepEqual(
      pressFromTarget(target, { key: '2', code: 'Digit2', ctrlKey: true }).actions,
      ['switchToTab'],
    );
    assert.deepEqual(
      pressFromTarget(target, { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true }, { hotkeyScheme: 'mac' }).actions,
      ['nextTab'],
    );
  }
});

test('tab switching still stays out of text fields that are not a work tab', () => {
  // The vault search box, a dialog field, an editor that did not opt in.
  for (const target of [new FakeInputHTMLElement(), new FakeMonacoHTMLElement()]) {
    const result = pressFromTarget(target, { key: 'Tab', code: 'Tab', ctrlKey: true });
    assert.deepEqual(result.actions, []);
    assert.equal(result.prevented, false);
    assert.deepEqual(pressFromTarget(target, { key: '2', code: 'Digit2', ctrlKey: true }).actions, []);
  }
});

test('only tab switching gets through a work tab text field', (t) => {
  const editor = new FakeWorkTabMonacoHTMLElement();
  // The close-tab chord looks for an open dialog first.
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  // Ctrl+W deletes a word in a shell and a database tab has no unsaved-changes
  // prompt: closing stays unavailable while typing.
  const close = pressFromTarget(editor, { key: 'w', code: 'KeyW', ctrlKey: true });
  assert.deepEqual(close.actions, []);
  assert.equal(close.prevented, false);
  // New local terminal.
  assert.deepEqual(pressFromTarget(editor, { key: 't', code: 'KeyT', ctrlKey: true }).actions, []);
  // Typing a digit, or picking an IME candidate with one, is not a shortcut.
  assert.deepEqual(pressFromTarget(editor, { key: '2', code: 'Digit2' }).actions, []);
  assert.deepEqual(
    pressFromTarget(editor, { key: '2', code: 'Digit2', ctrlKey: true, isComposing: true }).actions,
    [],
  );
  // AltGr+8 types "[" on a German layout.
  assert.deepEqual(
    pressFromTarget(editor, { key: '[', code: 'Digit8', ctrlKey: true, altKey: true }).actions,
    [],
  );
});

test('another action sharing a tab chord does not ride through the text field', () => {
  // Someone put "new tab" on the same chord as "next tab": inside the editor
  // only the tab switch may run, whichever comes first in the list.
  const keyBindings = [
    ...DEFAULT_KEY_BINDINGS.filter((binding) => binding.action !== 'newTab'),
  ];
  keyBindings.unshift({
    ...DEFAULT_KEY_BINDINGS.find((binding) => binding.action === 'newTab')!,
    pc: 'Ctrl + Tab',
  });
  const result = pressFromTarget(
    new FakeWorkTabMonacoHTMLElement(),
    { key: 'Tab', code: 'Tab', ctrlKey: true },
    { keyBindings },
  );
  assert.deepEqual(result.actions, ['nextTab']);
});
