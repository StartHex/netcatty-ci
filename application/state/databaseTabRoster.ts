/**
 * Which workbench tabs exist and which connection each one uses, kept in step
 * synchronously.
 *
 * The workbench keeps its tabs in React state, and state lands a render later.
 * Decisions made back to back cannot wait for that: "close all" raises one
 * close per tab in the same tick, and a tab can be closed before the render
 * that would list it. Read from a stale list, a pooled session stays open
 * because its sibling tab still looks alive, or one connection gets two tabs.
 */
export class DatabaseTabRoster {
  /** Tab id -> connection id, in tab order. */
  private readonly connectionByTab = new Map<string, string>();

  get size(): number {
    return this.connectionByTab.size;
  }

  /** Starts over from a restored tab list. */
  reset(tabs: Iterable<{ id: string; connectionId: string }>): void {
    this.connectionByTab.clear();
    for (const tab of tabs) this.connectionByTab.set(tab.id, tab.connectionId);
  }

  add(tabId: string, connectionId: string): void {
    this.connectionByTab.set(tabId, connectionId);
  }

  /** Removes the tab; false when it was not there (never opened, or already closed). */
  remove(tabId: string): boolean {
    return this.connectionByTab.delete(tabId);
  }

  has(tabId: string): boolean {
    return this.connectionByTab.has(tabId);
  }

  connectionOf(tabId: string): string | undefined {
    return this.connectionByTab.get(tabId);
  }

  /** The first tab on the connection, in tab order. */
  findByConnection(connectionId: string): string | undefined {
    for (const [tabId, tabConnectionId] of this.connectionByTab) {
      if (tabConnectionId === connectionId) return tabId;
    }
    return undefined;
  }

  /** Whether a tab (other than `exceptTabId`) still uses the connection. */
  isConnectionInUse(connectionId: string, exceptTabId?: string): boolean {
    for (const [tabId, tabConnectionId] of this.connectionByTab) {
      if (tabId !== exceptTabId && tabConnectionId === connectionId) return true;
    }
    return false;
  }
}
