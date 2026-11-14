import React, { useMemo, useRef, useState } from 'react';
import { Copy, Minus, Plus } from 'lucide-react';

import { jsonNodeSummary, safeParseJson } from '../../domain/http/responseBody';
import { cn } from '../../lib/utils';

export interface JsonTreeLabels {
  expand?: string;
  collapse?: string;
  copyValue?: string;
  /** Label for the "render more children" row of a paged branch. */
  showMore?: (remaining: number) => string;
}

interface JsonTreeViewerProps {
  text: string;
  className?: string;
  labels?: JsonTreeLabels;
  /**
   * Expand every branch on first render. Very large payloads still start
   * collapsed past the second level so the first paint stays cheap.
   */
  expandByDefault?: boolean;
  /** Copies the JSON for a node; the caller owns clipboard + feedback. */
  onCopyValue?: (text: string) => void;
}

interface JsonRowProps {
  label: string | null;
  value: unknown;
  depth: number;
  path: string;
  collapsedPaths: Set<string>;
  onToggle: (path: string) => void;
  labels: JsonTreeLabels;
  onCopyValue?: (text: string) => void;
}

const INDENT_PX = 14;
const MAX_LEAF_CHARS = 400;
/** Above this node count the tree falls back to a shallow initial view. */
const AUTO_EXPAND_NODE_LIMIT = 1500;
/** Above this node count only the root stays open on first paint. */
const SHALLOW_EXPAND_NODE_LIMIT = 20000;
/**
 * Children rendered per branch before a "show more" row. A 50k item array used
 * to mount every row at once and freeze the window.
 */
export const JSON_TREE_CHILD_PAGE_SIZE = 200;

const isBranch = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null && typeof value === 'object';

const valueClass = (value: unknown): string => {
  if (value === null) return 'text-muted-foreground';
  switch (typeof value) {
    case 'string':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'number':
      return 'text-sky-600 dark:text-sky-400';
    case 'boolean':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-foreground';
  }
};

const formatLeaf = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const text = value.length > MAX_LEAF_CHARS ? `${value.slice(0, MAX_LEAF_CHARS)}…` : value;
    return JSON.stringify(text);
  }
  return String(value);
};

const copyPayload = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const JsonRow: React.FC<JsonRowProps> = ({ label, value, depth, path, collapsedPaths, onToggle, labels, onCopyValue }) => {
  const branch = isBranch(value);
  const collapsed = branch && collapsedPaths.has(path);
  const [visibleCount, setVisibleCount] = useState(JSON_TREE_CHILD_PAGE_SIZE);
  // Only a user expand animates; the first paint of a big tree should not.
  const [animateChildren, setAnimateChildren] = useState(false);

  const entries: Array<[string, unknown]> = useMemo(() => {
    if (!branch) return [];
    if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
    return Object.entries(value as Record<string, unknown>);
  }, [branch, value]);
  const visibleEntries = entries.length > visibleCount ? entries.slice(0, visibleCount) : entries;
  const hiddenCount = entries.length - visibleEntries.length;

  return (
    <div>
      <div
        className="group flex items-start gap-1 rounded px-1 py-[1px] hover:bg-muted/60"
        style={{ paddingLeft: depth * INDENT_PX + 4 }}
      >
        {branch ? (
          <button
            type="button"
            onClick={() => {
              setAnimateChildren(collapsed);
              onToggle(path);
            }}
            className="mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-border/70 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            aria-label={collapsed ? labels.expand ?? 'Expand' : labels.collapse ?? 'Collapse'}
          >
            {collapsed ? <Plus size={10} /> : <Minus size={10} />}
          </button>
        ) : (
          <span className="mt-[1px] h-3.5 w-3.5 shrink-0" />
        )}
        {label !== null ? <span className="shrink-0 text-foreground">{label}:</span> : null}
        {branch ? (
          <span className="text-muted-foreground">
            {Array.isArray(value) ? '[' : '{'}
            {collapsed ? (
              <span className="mx-1 rounded bg-muted px-1 text-[10px]">{jsonNodeSummary(value)}</span>
            ) : null}
            {collapsed ? (Array.isArray(value) ? ']' : '}') : ''}
          </span>
        ) : (
          <span className={cn('break-all', valueClass(value))}>{formatLeaf(value)}</span>
        )}
        {onCopyValue ? (
          <button
            type="button"
            onClick={() => onCopyValue(copyPayload(value))}
            className="ml-auto hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
            aria-label={labels.copyValue ?? 'Copy value'}
          >
            <Copy size={11} />
          </button>
        ) : null}
      </div>
      {branch && !collapsed ? (
        <div className={animateChildren ? 'nc-anim-slide-down' : undefined}>
          {visibleEntries.map(([key, child]) => (
            <JsonRow
              key={`${path}/${key}`}
              label={key}
              value={child}
              depth={depth + 1}
              path={`${path}/${key}`}
              collapsedPaths={collapsedPaths}
              onToggle={onToggle}
              labels={labels}
              onCopyValue={onCopyValue}
            />
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="block rounded px-1 py-[1px] text-left text-[11px] text-primary/80 transition-colors hover:bg-muted/60 hover:text-primary"
              style={{ marginLeft: (depth + 1) * INDENT_PX + 4 }}
              data-testid="curl-json-show-more"
              onClick={() => setVisibleCount((count) => count + JSON_TREE_CHILD_PAGE_SIZE * 5)}
            >
              {labels.showMore ? labels.showMore(hiddenCount) : `… ${hiddenCount} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const JsonTreeViewer: React.FC<JsonTreeViewerProps> = ({
  text,
  className,
  labels = {},
  expandByDefault = true,
  onCopyValue,
}) => {
  const parsed = useMemo(() => safeParseJson(text), [text]);
  const initialCollapsed = useMemo(() => {
    const paths = new Set<string>();
    let count = 0;
    const walk = (value: unknown, depth: number, path: string, collapseFrom: number) => {
      if (!isBranch(value)) return;
      count += 1;
      if (depth >= collapseFrom) paths.add(path);
      const entries = Array.isArray(value)
        ? value.map((item, index) => [String(index), item] as const)
        : Object.entries(value as Record<string, unknown>);
      for (const [key, item] of entries) walk(item, depth + 1, `${path}/${key}`, collapseFrom);
    };
    // First pass counts nodes; the collapse depth depends on the payload size.
    walk(parsed, 0, '$', Number.POSITIVE_INFINITY);
    const collapseFrom = expandByDefault && count <= AUTO_EXPAND_NODE_LIMIT
      ? Number.POSITIVE_INFINITY
      : count <= SHALLOW_EXPAND_NODE_LIMIT
        ? 2
        : 1;
    paths.clear();
    walk(parsed, 0, '$', collapseFrom);
    return paths;
  }, [expandByDefault, parsed]);

  // The body can change while the tab stays mounted, so the collapse state is
  // keyed by the text that produced it.
  const [collapseState, setCollapseState] = useState<{ seed: string; paths: Set<string> }>({
    seed: text,
    paths: initialCollapsed,
  });
  const collapsedPaths = collapseState.seed === text ? collapseState.paths : initialCollapsed;
  // Remount the rows for a new body so paging / animation state starts fresh.
  const bodySeedRef = useRef({ text, key: 0 });
  if (bodySeedRef.current.text !== text) {
    bodySeedRef.current = { text, key: bodySeedRef.current.key + 1 };
  }

  if (parsed === undefined) {
    return (
      <pre className={cn('whitespace-pre-wrap break-all p-3 font-mono text-xs', className)} data-testid="curl-json-raw">
        {text}
      </pre>
    );
  }

  const toggle = (path: string) => {
    setCollapseState((current) => {
      const base = current.seed === text ? current.paths : initialCollapsed;
      const next = new Set(base);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { seed: text, paths: next };
    });
  };

  return (
    <div className={cn('p-2 font-mono text-xs', className)} data-testid="curl-json-tree">
      <JsonRow
        key={bodySeedRef.current.key}
        label={null}
        value={parsed}
        depth={0}
        path="$"
        collapsedPaths={collapsedPaths}
        onToggle={toggle}
        labels={labels}
        onCopyValue={onCopyValue}
      />
    </div>
  );
};
