import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { useCurlFolderCollapse } from '../../application/state/curlFolderUiStore';
import {
  curlFolderAncestors,
  curlFolderJoin,
  MAX_CURL_FOLDER_SEGMENTS,
  curlFolderLeafName,
  curlFolderParentPath,
  curlFolderSegments,
  sanitizeCurlFolderPath,
  type CurlRequest,
} from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

/** Method badge colors, shared with the flat search list in `CurlCollections`. */
export const CURL_METHOD_CLASS: Record<string, string> = {
  GET: 'text-emerald-500',
  POST: 'text-amber-500',
  PUT: 'text-sky-500',
  PATCH: 'text-fuchsia-500',
  DELETE: 'text-rose-500',
  HEAD: 'text-slate-500',
  OPTIONS: 'text-slate-500',
};

export const CURL_DRAG_MIME = 'application/x-netcatty-curl';

/** Marker used by the drop-target state for the "move to root" zone. */
const ROOT_DROP_TARGET = '__root__';

export type CurlDragPayload = { kind: 'request'; id: string } | { kind: 'folder'; id: string };

export function encodeCurlDragPayload(payload: CurlDragPayload): string {
  return JSON.stringify({ kind: payload.kind, id: payload.id });
}

export function decodeCurlDragPayload(raw: string | null | undefined): CurlDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; id?: unknown } | null;
    if (!parsed || (parsed.kind !== 'request' && parsed.kind !== 'folder')) return null;
    if (typeof parsed.id !== 'string' || !parsed.id.trim()) return null;
    if (parsed.kind === 'folder') {
      const path = sanitizeCurlFolderPath(parsed.id);
      return path ? { kind: 'folder', id: path } : null;
    }
    return { kind: 'request', id: parsed.id };
  } catch {
    return null;
  }
}

/** Read the drag payload from a drop event, falling back to `text/plain`. */
export function readCurlDragPayload(dataTransfer: DataTransfer | null): CurlDragPayload | null {
  if (!dataTransfer) return null;
  return decodeCurlDragPayload(dataTransfer.getData(CURL_DRAG_MIME))
    ?? decodeCurlDragPayload(dataTransfer.getData('text/plain'));
}

export interface CurlFolderNode {
  path: string;
  name: string;
  children: CurlFolderNode[];
  requests: CurlRequest[];
}

export interface CurlFolderTreeModel {
  folders: CurlFolderNode[];
  rootRequests: CurlRequest[];
}

const compareNames = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { sensitivity: 'base' });

const requestSortKey = (request: CurlRequest): string => request.name || request.url;

function sortFolderNodes(nodes: CurlFolderNode[]): void {
  nodes.sort((left, right) => compareNames(left.name, right.name) || compareNames(left.path, right.path));
  for (const node of nodes) {
    node.requests.sort((left, right) => compareNames(requestSortKey(left), requestSortKey(right)));
    sortFolderNodes(node.children);
  }
}

/**
 * Turn the flat folder paths + requests into a sorted tree. Requests whose
 * `folder` is not in the folder list still get their node created, so old vault
 * data never loses a request just because its folder list was not persisted.
 */
export function buildCurlFolderTree(
  folders: readonly string[],
  requests: readonly CurlRequest[],
): CurlFolderTreeModel {
  const paths = new Set<string>();
  const remember = (value: unknown): void => {
    const path = sanitizeCurlFolderPath(value);
    if (!path) return;
    paths.add(path);
    for (const ancestor of curlFolderAncestors(path)) paths.add(ancestor);
  };
  for (const folder of folders) remember(folder);
  for (const request of requests) remember(request.folder);

  const nodes = new Map<string, CurlFolderNode>();
  const sortedPaths = [...paths].sort((left, right) => {
    const depth = curlFolderSegments(left).length - curlFolderSegments(right).length;
    return depth !== 0 ? depth : compareNames(left, right);
  });
  for (const path of sortedPaths) {
    nodes.set(path, { path, name: curlFolderLeafName(path), children: [], requests: [] });
  }

  const rootFolders: CurlFolderNode[] = [];
  for (const path of sortedPaths) {
    const node = nodes.get(path);
    if (!node) continue;
    const parentPath = curlFolderParentPath(path);
    const parent = parentPath ? nodes.get(parentPath) : undefined;
    if (parent) parent.children.push(node);
    else rootFolders.push(node);
  }

  const rootRequests: CurlRequest[] = [];
  for (const request of requests) {
    const path = sanitizeCurlFolderPath(request.folder);
    const node = path ? nodes.get(path) : undefined;
    if (node) node.requests.push(request);
    else rootRequests.push(request);
  }

  sortFolderNodes(rootFolders);
  rootRequests.sort((left, right) => compareNames(requestSortKey(left), requestSortKey(right)));
  return { folders: rootFolders, rootRequests };
}

/** Expand a folder and every ancestor so a newly dropped request is visible. */
export function curlFolderRevealChain(path: string): string[] {
  const sanitized = sanitizeCurlFolderPath(path);
  if (!sanitized) return [];
  return [...curlFolderAncestors(sanitized), sanitized];
}

interface CurlFolderTreeContextValue {
  collapsed: ReadonlySet<string>;
  toggleCollapsed: (path: string) => void;
  setCollapsed: (path: string, collapsed: boolean) => void;
  editingFolder: string | null;
  beginRenameFolder: (path: string) => void;
  cancelRenameFolder: () => void;
  editingRequest: string | null;
  beginRenameRequest: (id: string) => void;
  cancelRenameRequest: () => void;
  dragging: CurlDragPayload | null;
  dropTarget: string | null;
  setDropTarget: React.Dispatch<React.SetStateAction<string | null>>;
  beginDrag: (payload: CurlDragPayload, event: React.DragEvent<HTMLElement>) => void;
  endDrag: () => void;
  dropOnFolder: (folderPath: string, event: React.DragEvent<HTMLElement>) => void;
  pulseFolder: string | null;
  creatingFolderKey: string | null;
  onCommitCreateFolder: (name: string, parent: string | undefined) => void;
  onCancelCreateFolder: () => void;
  onStartCreateFolder: (parent: string | undefined) => void;
  onRenameFolder: (path: string, nextPath: string) => void;
  onRenameRequest: (id: string, name: string) => void;
  onDeleteFolder: (path: string) => void;
  onMoveRequest: (requestId: string, folder: string | undefined) => void;
  onMoveFolder: (path: string, parent: string | undefined) => void;
  onOpenRequest: (request: CurlRequest) => void;
  onDeleteRequest: (request: CurlRequest) => void;
}

const CurlFolderTreeContext = createContext<CurlFolderTreeContextValue | null>(null);

function useCurlFolderTreeContext(): CurlFolderTreeContextValue {
  const context = useContext(CurlFolderTreeContext);
  if (!context) throw new Error('CurlFolderTree context is missing');
  return context;
}

/** True when the drag started inside an inline input or a hover action button. */
function isInteractiveDragOrigin(event: React.DragEvent<HTMLElement>): boolean {
  const target = event.target;
  return target instanceof HTMLElement && target.closest('input, textarea, [data-no-drag="true"]') !== null;
}

const InlineNameInput: React.FC<{
  defaultValue?: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}> = ({ defaultValue = '', placeholder, onCommit, onCancel, className }) => {
  const [value, setValue] = useState(defaultValue);
  const settledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const element = inputRef.current;
    element?.focus();
    element?.select();
  }, []);

  const settle = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = value.trim();
    if (commit && trimmed) onCommit(trimmed);
    else onCancel();
  };

  return (
    <Input
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      data-no-drag="true"
      draggable={false}
      className={cn('h-7 min-w-0 flex-1 rounded-sm px-2 text-sm', className)}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          settle(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          settle(false);
        }
      }}
      onBlur={() => settle(true)}
    />
  );
};

const RequestRow: React.FC<{ request: CurlRequest; depth: number }> = ({ request, depth }) => {
  const { t } = useI18n();
  const context = useCurlFolderTreeContext();
  const isDragging = context.dragging?.kind === 'request' && context.dragging.id === request.id;
  const isEditing = context.editingRequest === request.id;

  return (
    <div
      role="treeitem"
      aria-selected={false}
      tabIndex={0}
      draggable
      data-curl-request-id={request.id}
      className={cn(
        'group flex items-center gap-3 rounded-md border border-transparent px-3 py-1.5 transition-colors',
        'hover:border-border/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
        isDragging && 'opacity-40',
      )}
      style={{ paddingLeft: `${depth * 16 + 12}px` }}
      onDragStart={(event) => context.beginDrag({ kind: 'request', id: request.id }, event)}
      onDragEnd={context.endDrag}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          context.onOpenRequest(request);
        }
      }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={() => context.onOpenRequest(request)}
      >
        <span className={cn('w-16 shrink-0 font-mono text-[11px] font-semibold', CURL_METHOD_CLASS[request.method])}>
          {request.method}
        </span>
        <span className="min-w-0 flex-1">
          {isEditing ? (
            <InlineNameInput
              defaultValue={request.name ?? ''}
              placeholder={request.url}
              onCommit={(value) => {
                const next = value.trim();
                if (next && next !== request.name) context.onRenameRequest(request.id, next);
                context.cancelRenameRequest();
              }}
              onCancel={context.cancelRenameRequest}
            />
          ) : (
            <>
              <span className="block truncate text-sm font-medium">{request.name || request.url}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">{request.url}</span>
            </>
          )}
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t('curl.requestRename')}
        data-testid={`curl-request-rename-${request.id}`}
        data-no-drag="true"
        onClick={() => context.beginRenameRequest(request.id)}
      >
        <Pencil size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t('curl.delete')}
        data-no-drag="true"
        onClick={() => context.onDeleteRequest(request)}
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
};

const FolderRow: React.FC<{ node: CurlFolderNode; depth: number }> = ({ node, depth }) => {
  const { t } = useI18n();
  const context = useCurlFolderTreeContext();
  const dragDepthRef = useRef(0);
  const isCollapsed = context.collapsed.has(node.path);
  const isDropTarget = context.dropTarget === node.path;
  const isDragging = context.dragging?.kind === 'folder' && context.dragging.id === node.path;
  const isEditing = context.editingFolder === node.path;
  const isPulsing = context.pulseFolder === node.path;
  const isCreatingChild = context.creatingFolderKey === node.path;

  const allowsDrop = (() => {
    const payload = context.dragging;
    if (!payload) return false;
    if (payload.kind === 'request') return true;
    const target = node.path;
    const source = payload.id;
    return target !== source
      && !target.startsWith(`${source}/`)
      && curlFolderSegments(target).length < MAX_CURL_FOLDER_SEGMENTS;
  })();

  return (
    <div role="treeitem" aria-expanded={!isCollapsed} className="select-none">
      <div
        tabIndex={0}
        draggable={!isEditing}
        data-curl-folder-path={node.path}
        className={cn(
          'group flex items-center gap-1 rounded-md border border-transparent px-2 py-1.5 transition-colors',
          'hover:border-border/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
          isDropTarget && 'border-primary/40 bg-primary/10 ring-1 ring-primary/30',
          isDragging && 'opacity-40',
          isPulsing && 'bg-primary/10',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onDragStart={(event) => {
          if (isEditing) {
            event.preventDefault();
            return;
          }
          context.beginDrag({ kind: 'folder', id: node.path }, event);
        }}
        onDragEnd={() => {
          dragDepthRef.current = 0;
          context.endDrag();
        }}
        onDragEnter={(event) => {
          if (!allowsDrop) return;
          event.preventDefault();
          event.stopPropagation();
          dragDepthRef.current += 1;
          context.setDropTarget(node.path);
        }}
        onDragOver={(event) => {
          if (!allowsDrop) {
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        }}
        onDragLeave={(event) => {
          event.stopPropagation();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) {
            context.setDropTarget((current) => (current === node.path ? null : current));
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dragDepthRef.current = 0;
          context.dropOnFolder(node.path, event);
        }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement | null)?.closest('[data-no-drag="true"]')) return;
          context.beginRenameFolder(node.path);
        }}
        onKeyDown={(event) => {
          if (event.key === 'F2') {
            event.preventDefault();
            context.beginRenameFolder(node.path);
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            context.toggleCollapsed(node.path);
          }
        }}
      >
        <button
          type="button"
          aria-label={isCollapsed ? t('curl.folderExpand') : t('curl.folderCollapse')}
          data-no-drag="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            context.toggleCollapsed(node.path);
          }}
        >
          <ChevronRight size={14} className={cn('transition-transform duration-150', !isCollapsed && 'rotate-90')} />
        </button>
        {isCollapsed
          ? <Folder size={14} className="shrink-0 text-muted-foreground" />
          : <FolderOpen size={14} className="shrink-0 text-muted-foreground" />}
        {isEditing ? (
          <InlineNameInput
            defaultValue={node.name}
            placeholder={t('curl.folderNamePlaceholder')}
            onCommit={(value) => {
              const nextPath = curlFolderJoin(curlFolderParentPath(node.path), value);
              if (nextPath && nextPath !== node.path) context.onRenameFolder(node.path, nextPath);
              context.cancelRenameFolder();
            }}
            onCancel={context.cancelRenameFolder}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm font-medium"
            onClick={(event) => {
              event.stopPropagation();
              context.toggleCollapsed(node.path);
            }}
          >
            {node.name}
          </button>
        )}
        {isEditing ? null : (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('curl.folderNewSubfolder')}
              title={t('curl.folderNewSubfolder')}
              data-no-drag="true"
              onClick={(event) => {
                event.stopPropagation();
                context.setCollapsed(node.path, false);
                context.onStartCreateFolder(node.path);
              }}
            >
              <FolderPlus size={13} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('curl.folderRename')}
              title={t('curl.folderRename')}
              data-no-drag="true"
              onClick={(event) => {
                event.stopPropagation();
                context.beginRenameFolder(node.path);
              }}
            >
              <Pencil size={13} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('curl.folderDelete')}
              title={t('curl.folderDelete')}
              data-no-drag="true"
              onClick={(event) => {
                event.stopPropagation();
                context.onDeleteFolder(node.path);
              }}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        )}
      </div>

      {isCreatingChild ? (
        <div className="flex items-center gap-2 py-1" style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}>
          <FolderPlus size={14} className="shrink-0 text-muted-foreground" />
          <InlineNameInput
            placeholder={t('curl.folderNamePlaceholder')}
            onCommit={(value) => context.onCommitCreateFolder(value, node.path)}
            onCancel={context.onCancelCreateFolder}
          />
        </div>
      ) : null}

      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          isCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div role="group">
            {node.children.map((child) => (
              <FolderRow key={child.path} node={child} depth={depth + 1} />
            ))}
            {node.requests.map((request) => (
              <RequestRow key={request.id} request={request} depth={depth + 1} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export interface CurlFolderTreeProps {
  folders: readonly string[];
  requests: readonly CurlRequest[];
  creatingParent?: string;
  creating: boolean;
  onStartCreateFolder: (parent: string | undefined) => void;
  onCancelCreateFolder: () => void;
  onCommitCreateFolder: (name: string, parent: string | undefined) => void;
  onRenameFolder: (path: string, nextPath: string) => void;
  onRenameRequest: (id: string, name: string) => void;
  onDeleteFolder: (path: string) => void;
  onMoveRequest: (requestId: string, folder: string | undefined) => void;
  onMoveFolder: (path: string, parent: string | undefined) => void;
  onOpenRequest: (request: CurlRequest) => void;
  onDeleteRequest: (request: CurlRequest) => void;
}

export const CurlFolderTree: React.FC<CurlFolderTreeProps> = ({
  folders,
  requests,
  creatingParent,
  creating,
  onStartCreateFolder,
  onCancelCreateFolder,
  onCommitCreateFolder,
  onRenameFolder,
  onRenameRequest,
  onDeleteFolder,
  onMoveRequest,
  onMoveFolder,
  onOpenRequest,
  onDeleteRequest,
}) => {
  const { t } = useI18n();
  const { collapsed, toggleCollapsed, setCollapsed } = useCurlFolderCollapse();
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editingRequest, setEditingRequest] = useState<string | null>(null);
  const [dragging, setDragging] = useState<CurlDragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pulseFolder, setPulseFolder] = useState<string | null>(null);
  const rootDragDepthRef = useRef(0);
  const pulseTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
  }, []);

  const revealFolder = useCallback((path: string | undefined) => {
    if (!path) return;
    for (const chainPath of curlFolderRevealChain(path)) setCollapsed(chainPath, false);
    setPulseFolder(path);
    if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => {
      pulseTimerRef.current = null;
      setPulseFolder((current) => (current === path ? null : current));
    }, 600);
  }, [setCollapsed]);

  const beginDrag = useCallback((payload: CurlDragPayload, event: React.DragEvent<HTMLElement>) => {
    if (isInteractiveDragOrigin(event)) {
      event.preventDefault();
      return;
    }
    setDragging(payload);
    setDropTarget(null);
    rootDragDepthRef.current = 0;
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    const serialized = encodeCurlDragPayload(payload);
    try {
      dataTransfer.setData(CURL_DRAG_MIME, serialized);
      dataTransfer.setData('text/plain', serialized);
    } catch {
      // Some browsers reject custom MIME types outside a trusted drag.
    }
    dataTransfer.effectAllowed = 'move';
  }, []);

  const endDrag = useCallback(() => {
    setDragging(null);
    setDropTarget(null);
    rootDragDepthRef.current = 0;
  }, []);

  const dropOnFolder = useCallback((folderPath: string, event: React.DragEvent<HTMLElement>) => {
    const payload = readCurlDragPayload(event.dataTransfer) ?? dragging;
    setDropTarget(null);
    setDragging(null);
    if (!payload) return;
    if (payload.kind === 'request') {
      onMoveRequest(payload.id, folderPath);
      revealFolder(folderPath);
      return;
    }
    if (payload.id === folderPath) return;
    if (curlFolderSegments(folderPath).length >= MAX_CURL_FOLDER_SEGMENTS) return;
    if (folderPath.startsWith(`${payload.id}/`)) return;
    onMoveFolder(payload.id, folderPath);
    revealFolder(folderPath);
  }, [dragging, onMoveFolder, onMoveRequest, revealFolder]);

  const dropOnRoot = useCallback((event: React.DragEvent<HTMLElement>) => {
    const payload = readCurlDragPayload(event.dataTransfer) ?? dragging;
    setDropTarget(null);
    setDragging(null);
    rootDragDepthRef.current = 0;
    if (!payload) return;
    if (payload.kind === 'request') onMoveRequest(payload.id, undefined);
    else onMoveFolder(payload.id, undefined);
  }, [dragging, onMoveFolder, onMoveRequest]);

  const contextValue = useMemo<CurlFolderTreeContextValue>(() => ({
    collapsed,
    toggleCollapsed,
    setCollapsed,
    editingFolder,
    beginRenameFolder: (path: string) => setEditingFolder(path),
    cancelRenameFolder: () => setEditingFolder(null),
    editingRequest,
    beginRenameRequest: (id: string) => setEditingRequest(id),
    cancelRenameRequest: () => setEditingRequest(null),
    dragging,
    dropTarget,
    setDropTarget,
    beginDrag,
    endDrag,
    dropOnFolder,
    pulseFolder,
    creatingFolderKey: creating ? (creatingParent ?? null) : null,
    onCommitCreateFolder: (name: string, parent: string | undefined) => onCommitCreateFolder(name, parent),
    onCancelCreateFolder,
    onStartCreateFolder,
    onRenameFolder,
    onRenameRequest,
    onDeleteFolder,
    onMoveRequest,
    onMoveFolder,
    onOpenRequest,
    onDeleteRequest,
  }), [
    beginDrag,
    collapsed,
    creating,
    creatingParent,
    dragging,
    dropOnFolder,
    dropTarget,
    editingFolder,
    editingRequest,
    endDrag,
    onCancelCreateFolder,
    onCommitCreateFolder,
    onDeleteFolder,
    onDeleteRequest,
    onMoveFolder,
    onMoveRequest,
    onOpenRequest,
    onRenameFolder,
    onRenameRequest,
    onStartCreateFolder,
    pulseFolder,
    setCollapsed,
    toggleCollapsed,
  ]);

  const model = useMemo(() => buildCurlFolderTree(folders, requests), [folders, requests]);
  const isRootDropTarget = dropTarget === ROOT_DROP_TARGET;

  return (
    <CurlFolderTreeContext.Provider value={contextValue}>
      <div
        role="tree"
        aria-label={t('curl.folderTreeLabel')}
        className="min-h-full px-3 pb-6"
        onDragOver={(event) => {
          if (!dragging || event.target !== event.currentTarget) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          setDropTarget(ROOT_DROP_TARGET);
        }}
        onDragLeave={(event) => {
          if (event.target !== event.currentTarget) return;
          if (dropTarget === ROOT_DROP_TARGET) setDropTarget(null);
        }}
        onDrop={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          dropOnRoot(event);
        }}
      >
        {creating && !creatingParent ? (
          <div className="flex items-center gap-2 py-1 pl-2">
            <FolderPlus size={14} className="shrink-0 text-muted-foreground" />
            <InlineNameInput
              placeholder={t('curl.folderNamePlaceholder')}
              onCommit={(value) => onCommitCreateFolder(value, undefined)}
              onCancel={onCancelCreateFolder}
            />
          </div>
        ) : null}

        {model.folders.map((node) => (
          <FolderRow key={node.path} node={node} depth={0} />
        ))}
        {model.rootRequests.map((request) => (
          <RequestRow key={request.id} request={request} depth={0} />
        ))}

        {dragging ? (
          <div
            className={cn(
              'mt-2 flex items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors',
              isRootDropTarget && 'border-primary/50 bg-primary/10 text-foreground',
            )}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              rootDragDepthRef.current += 1;
              setDropTarget(ROOT_DROP_TARGET);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            }}
            onDragLeave={(event) => {
              event.stopPropagation();
              rootDragDepthRef.current = Math.max(0, rootDragDepthRef.current - 1);
              if (rootDragDepthRef.current === 0) {
                setDropTarget((current) => (current === ROOT_DROP_TARGET ? null : current));
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              dropOnRoot(event);
            }}
          >
            {t('curl.folderDropToRoot')}
          </div>
        ) : null}
      </div>
    </CurlFolderTreeContext.Provider>
  );
};
