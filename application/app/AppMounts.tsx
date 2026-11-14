import React, { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeTabStore, useActiveTabId, useIsSftpActive, useIsVaultActive } from '../state/activeTabStore';

const activeTabStoreSetActive = (tabId: string) => activeTabStore.setActiveTabId(tabId);
import { fromDatabaseTabId, isDatabaseTabId } from '../state/databaseTabStore';
import { fromCurlTabId, isCurlTabId } from '../state/curlTabStore';
import { fromNoteTabId, isNoteTabId, noteTabStore, useNoteTabIds } from '../state/noteTabStore';
import { useNotesStore } from '../state/notesStore';
import { useTerminalHostTreeLayoutWidth } from '../state/terminalHostTreeStore';
import { isTerminalContentTabSurface } from './workTabSurface';
import { TAB_NAVIGATION_HOTKEY_SCOPE } from '../../domain/tabNavigationHotkeys';
import { cn } from '../../lib/utils';
import { ConnectionLog, TerminalTheme } from '../../types';
import { LazyLoadBoundary } from '../../components/ui/lazy-load-boundary';
import type { LogView as LogViewType } from '../state/logViewState';
import type { SftpView as SftpViewComponent } from '../../components/SftpView';
import type { TerminalLayer as TerminalLayerComponent } from '../../components/TerminalLayer';
import type { CurlRequest, DatabaseConnection, Host } from '../../domain/models';
import type { DatabaseTunnelDeps } from '../state/useDatabaseWorkbench';

// Visibility container for VaultView - isolates isActive subscription
export const VaultViewContainer: React.FC<{
  children: React.ReactNode;
  appThemeStyle?: React.CSSProperties;
}> = ({ children, appThemeStyle }) => {
  const isActive = useIsVaultActive();
  const wasActiveRef = useRef(isActive);
  const [suppressActiveTransition, setSuppressActiveTransition] = useState(false);
  const isActivating = isActive && !wasActiveRef.current;
  const shouldSuppressTransition = isActivating || suppressActiveTransition;
  const containerStyle: React.CSSProperties = isActive
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!isActive || wasActive) return;

    setSuppressActiveTransition(true);
    const view = window;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = view.requestAnimationFrame(() => {
      secondFrame = view.requestAnimationFrame(() => {
        setSuppressActiveTransition(false);
      });
    });

    return () => {
      view.cancelAnimationFrame(firstFrame);
      view.cancelAnimationFrame(secondFrame);
    };
  }, [isActive]);

  return (
    <div
      className={cn("absolute inset-0", isActive ? "z-20" : "")}
      data-inactive-app-surface={isActive ? undefined : "true"}
      data-app-surface-transition-suppressed={shouldSuppressTransition ? "true" : undefined}
      style={{ ...appThemeStyle, ...containerStyle }}
    >
      {children}
    </div>
  );
};

// LogView wrapper - manages visibility based on active tab
interface LogViewWrapperProps {
  logView: LogViewType;
  defaultTerminalTheme: TerminalTheme;
  defaultFontSize: number;
  onClose: () => void;
  onUpdateLog: (logId: string, updates: Partial<ConnectionLog>) => void;
}

export function getLogViewWrapperStyle(
  isVisible: boolean,
  hostTreeLayoutWidth: number,
): React.CSSProperties {
  const baseStyle = {
    left: hostTreeLayoutWidth,
  };
  return isVisible
    ? baseStyle
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1, ...baseStyle };
}

export const LogViewWrapper: React.FC<LogViewWrapperProps> = ({ logView, defaultTerminalTheme, defaultFontSize, onClose, onUpdateLog }) => {
  const activeTabId = useActiveTabId();
  const isVisible = activeTabId === logView.id;
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();

  const containerStyle = getLogViewWrapperStyle(isVisible, hostTreeLayoutWidth);

  return (
    <div
      className={cn("absolute inset-0", isVisible ? "z-20" : "")}
      data-inactive-app-surface={isVisible ? undefined : "true"}
      style={containerStyle}
    >
      <LazyLoadBoundary name="Log view" resetKey={logView.id}>
        <Suspense fallback={<LogViewFallback />}>
          <LazyLogView
            log={logView.log}
            defaultTerminalTheme={defaultTerminalTheme}
            defaultFontSize={defaultFontSize}
            isVisible={isVisible}
            onClose={onClose}
            onUpdateLog={onUpdateLog}
          />
        </Suspense>
      </LazyLoadBoundary>
    </div>
  );
};

const LazyLogView = lazy(() => import('../../components/LogView'));

const LazySftpView = lazy(() =>
  import('../../components/SftpView').then((m) => ({ default: m.SftpView })),
);

const LazyTerminalLayer = lazy(() =>
  import('../../components/TerminalLayer').then((m) => ({ default: m.TerminalLayer })),
);

type SftpViewProps = React.ComponentProps<typeof SftpViewComponent>;
type TerminalLayerProps = React.ComponentProps<typeof TerminalLayerComponent>;

const LogViewFallback = () => (
  <div className="netcatty-lazy-fade-in h-full min-h-0 bg-background" aria-hidden="true" />
);

const SftpViewFallback = ({ visible }: { visible: boolean }) => {
  if (!visible) return null;
  return (
    <div className="netcatty-lazy-fade-in absolute inset-0 z-20 bg-background" aria-hidden="true" />
  );
};

const TerminalLayerFallback = ({ visible }: { visible: boolean }) => {
  if (!visible) return null;
  return (
    <div className="netcatty-lazy-fade-in absolute inset-0 z-20 bg-background" aria-hidden="true" />
  );
};

export function shouldRenderTerminalLayerMount(
  isVisible: boolean,
  shouldMount: boolean,
): boolean {
  return isVisible || shouldMount;
}

export const SftpViewMount: React.FC<SftpViewProps> = (props) => {
  const isActive = useIsSftpActive();
  const [shouldMount, setShouldMount] = useState(isActive);

  useEffect(() => {
    if (isActive) setShouldMount(true);
  }, [isActive]);

  if (!shouldMount) return null;

  return (
    <LazyLoadBoundary name="SFTP" resetKey={isActive ? "active" : "idle"}>
      <Suspense fallback={<SftpViewFallback visible={isActive} />}>
        <LazySftpView {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
};

export const TerminalLayerMount: React.FC<TerminalLayerProps> = (props) => {
  const activeTabId = useActiveTabId();
  const sessionIds = useMemo(() => new Set(props.sessions.map((session) => session.id)), [props.sessions]);
  const workspaceIds = useMemo(() => new Set(props.workspaces.map((workspace) => workspace.id)), [props.workspaces]);
  const isVisible = isTerminalContentTabSurface({
    activeTabId,
    sessionIds,
    workspaceIds,
  }) || !!props.draggingSessionId;
  // Silent MCP sessions never become the activeTabId, so `isVisible` alone
  // would leave this whole layer (and its PTY-starting TerminalPane) unmounted
  // for up to 5s (the idle-callback fallback below) after host_open returns —
  // long enough for an immediate terminal_execute to race an unstarted session.
  const hasHiddenSession = props.sessions.some((session) => session.hiddenFromTabs);
  const [shouldMount, setShouldMount] = useState(isVisible || hasHiddenSession);

  useEffect(() => {
    if (isVisible || hasHiddenSession) setShouldMount(true);
  }, [isVisible, hasHiddenSession]);

  useEffect(() => {
    if (shouldMount) return;
    type IdleWindow = Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      const id = idleWindow.requestIdleCallback(() => setShouldMount(true), { timeout: 5000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setShouldMount(true), 5000);
    return () => window.clearTimeout(id);
  }, [shouldMount]);

  const shouldRender = shouldRenderTerminalLayerMount(isVisible, shouldMount);

  if (!shouldRender) return null;

  return (
    <LazyLoadBoundary name="Terminal" resetKey={activeTabId}>
      <Suspense fallback={<TerminalLayerFallback visible={isVisible} />}>
        <LazyTerminalLayer {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
};

const LazyDatabaseWorkbenchSurface = lazy(() =>
  import('../../components/databases/DatabaseWorkbenchSurface').then((m) => ({ default: m.DatabaseWorkbenchSurface })),
);

const LazyCurlClientSurface = lazy(() =>
  import('../../components/curl/CurlClientSurface').then((m) => ({ default: m.CurlClientSurface })),
);

/**
 * Full-bleed work surfaces (curl, database) render under the host tree sidebar,
 * which the app mounts as an absolutely positioned overlay at a higher z-index.
 * Offsetting the surface's left edge by the live sidebar width keeps both panels
 * visible side by side instead of the sidebar covering the surface. The width is
 * 0 while the sidebar is collapsed, so this stays a no-op by default.
 */
export function getWorkSurfaceInsetStyle(
  isActive: boolean,
  hostTreeLayoutWidth: number,
): React.CSSProperties {
  const inset: React.CSSProperties = { left: hostTreeLayoutWidth };
  return isActive
    ? inset
    : {
        visibility: 'hidden',
        pointerEvents: 'none',
        position: 'absolute',
        zIndex: -1,
        // `visibility: hidden` still keeps the subtree in the render tree, so a
        // database pane with a Monaco editor and a result grid kept paying for
        // paint and style work on every host-tab switch (very noticeable on
        // Windows). `content-visibility: hidden` skips that work entirely while
        // keeping React state, drafts and scroll positions alive.
        contentVisibility: 'hidden',
        contain: 'strict',
        ...inset,
      };
}

/**
 * Database workbench surface. Stays mounted while another tab is active so SQL
 * drafts, results and pooled connections survive tab switches (same contract as
 * VaultViewContainer).
 */
export const DatabaseWorkbenchMount: React.FC<{
  connections: readonly DatabaseConnection[];
  tunnelDeps?: DatabaseTunnelDeps;
  onUpdateConnections?: (
    connections: DatabaseConnection[] | ((prev: DatabaseConnection[]) => DatabaseConnection[]),
  ) => void;
}> = ({ connections, tunnelDeps, onUpdateConnections }) => {
  const activeTabId = useActiveTabId();
  const isActive = isDatabaseTabId(activeTabId);
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  const containerStyle = getWorkSurfaceInsetStyle(isActive, hostTreeLayoutWidth);

  return (
    <div
      className={cn('absolute inset-0', isActive ? 'z-20' : '')}
      data-inactive-app-surface={isActive ? undefined : 'true'}
      {...TAB_NAVIGATION_HOTKEY_SCOPE}
      // `inert` also keeps the hidden surface out of focus order and the a11y
      // tree, which avoids extra work when the user tabs back to a host.
      inert={isActive ? undefined : true}
      aria-hidden={isActive ? undefined : true}
      style={containerStyle}
    >
      <LazyLoadBoundary name="Database workbench" resetKey="database">
        <Suspense fallback={null}>
          <LazyDatabaseWorkbenchSurface
            tabId={isActive ? fromDatabaseTabId(activeTabId) : null}
            connections={[...connections]}
            tunnelDeps={tunnelDeps}
            onUpdateConnections={onUpdateConnections}
          />
        </Suspense>
      </LazyLoadBoundary>
    </div>
  );
};

/**
 * Curl client surface. Stays mounted while another tab is active so in-flight
 * responses, drafts and history survive tab switches.
 */
export const CurlClientMount: React.FC<{
  requests: readonly CurlRequest[];
  onUpdateRequests: (next: CurlRequest[]) => void | Promise<void>;
}> = ({ requests, onUpdateRequests }) => {
  const activeTabId = useActiveTabId();
  const isActive = isCurlTabId(activeTabId);
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  const containerStyle = getWorkSurfaceInsetStyle(isActive, hostTreeLayoutWidth);

  return (
    <div
      className={cn('absolute inset-0', isActive ? 'z-20' : '')}
      data-inactive-app-surface={isActive ? undefined : 'true'}
      {...TAB_NAVIGATION_HOTKEY_SCOPE}
      style={containerStyle}
    >
      <LazyLoadBoundary name="Curl client" resetKey="curl">
        <Suspense fallback={null}>
          <LazyCurlClientSurface
            tabId={isActive ? fromCurlTabId(activeTabId) : null}
            requests={requests}
            onUpdateRequests={onUpdateRequests}
          />
        </Suspense>
      </LazyLoadBoundary>
    </div>
  );
};

const LazyNotesManager = lazy(() =>
  import('../../components/notes/NotesManager').then((module) => ({ default: module.NotesManager })),
);

const openNoteInTab = (noteId: string) => noteTabStore.open(noteId);

/**
 * Body of the note tabs. One editor serves every note tab: the active tab
 * decides which note it shows. It stays mounted while another tab is active so
 * returning to a note is instant, and loads only once a note tab exists.
 */
export const NoteTabsMount: React.FC<{
  hosts: Host[];
  onOpenHost?: (host: Host) => void;
}> = ({ hosts, onOpenHost }) => {
  const activeTabId = useActiveTabId();
  const noteTabIds = useNoteTabIds();
  const isActive = isNoteTabId(activeTabId);
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  const containerStyle = getWorkSurfaceInsetStyle(isActive, hostTreeLayoutWidth);
  // Keep showing the last note while another tab is in front.
  const pinnedRef = useRef<string | null>(null);
  if (isActive) pinnedRef.current = fromNoteTabId(activeTabId);
  const { notes, noteGroups, updateNotes, updateNoteGroups } = useNotesStore({ enabled: isActive });

  // A note deleted here, in the vault or by a sync takes its tab with it.
  useEffect(() => {
    if (!isActive || notes.length === 0) return;
    const gone = noteTabStore.prune(new Set(notes.map((note) => note.id)));
    if (gone.includes(fromNoteTabId(activeTabId))) {
      const remaining = noteTabStore.getNoteIds();
      activeTabStoreSetActive(remaining.length > 0 ? `note:${remaining[remaining.length - 1]}` : 'vault');
    }
  }, [activeTabId, isActive, notes]);

  if (noteTabIds.length === 0) return null;

  return (
    <div
      className={cn('absolute inset-0 bg-background', isActive ? 'z-20' : '')}
      data-inactive-app-surface={isActive ? undefined : 'true'}
      data-section="note-tab-surface"
      {...TAB_NAVIGATION_HOTKEY_SCOPE}
      style={containerStyle}
    >
      <LazyLoadBoundary name="Notes" resetKey="note-tabs">
        <Suspense fallback={null}>
          <LazyNotesManager
            notes={notes}
            noteGroups={noteGroups}
            hosts={hosts}
            onUpdateNotes={updateNotes}
            onUpdateNoteGroups={updateNoteGroups}
            onOpenHost={onOpenHost}
            displayMode="tab"
            isActive={isActive}
            pinnedNoteId={pinnedRef.current}
            onOpenNoteInTab={openNoteInTab}
          />
        </Suspense>
      </LazyLoadBoundary>
    </div>
  );
};
