import React, { useMemo, useState } from 'react';
import { Copy, FolderPlus, Plus, Trash2, Waypoints } from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { curlTabStore } from '../../application/state/curlTabStore';
import { useCurlFolderCollapse } from '../../application/state/curlFolderUiStore';
import {
  curlFolderAncestors,
  curlFolderIsWithin,
  curlFolderJoin,
  curlFolderParentPath,
  duplicateCurlRequest,
  removeCurlFolderSubtree,
  reparentCurlFolderPath,
  rewriteCurlFolders,
  rewriteCurlRequestFolders,
  sanitizeCurlFolderPath,
  sanitizeCurlFolders,
  type CurlRequest,
} from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ScrollArea } from '../ui/scroll-area';
import {
  VaultHeaderSearch,
  VaultPageHeader,
  vaultHeaderSecondaryButtonClass,
  vaultSectionTitleClass,
} from '../vault/VaultPageHeader';
import { CURL_METHOD_CLASS, CurlFolderTree } from './CurlFolderTree';

export const CurlCollections: React.FC<{
  requests: readonly CurlRequest[];
  onUpdateRequests: (next: CurlRequest[]) => void | Promise<void>;
  /** Every known collection folder path; omitted by older call sites. */
  folders?: readonly string[];
  onUpdateFolders?: (next: string[]) => void | Promise<void>;
}> = ({ requests, onUpdateRequests, folders = [], onUpdateFolders }) => {
  const { t } = useI18n();
  const { setCollapsed } = useCurlFolderCollapse();
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<CurlRequest | null>(null);
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingParent, setCreatingParent] = useState<string | undefined>(undefined);

  /** Persisted folders + folders implied by the saved requests (old vault data). */
  const folderList = useMemo(
    () => sanitizeCurlFolders([
      ...folders,
      ...(requests ?? []).map((request) => request.folder ?? ''),
    ]),
    [folders, requests],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...(requests ?? [])].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    if (!needle) return sorted;
    return sorted.filter(
      (request) =>
        request.name.toLowerCase().includes(needle) ||
        request.url.toLowerCase().includes(needle) ||
        request.method.toLowerCase().includes(needle) ||
        (request.folder ?? '').toLowerCase().includes(needle),
    );
  }, [requests, query]);

  const openRequest = (request: CurlRequest) => {
    void onUpdateRequests(
      (requests ?? []).map((item) => (item.id === request.id ? { ...item, lastUsedAt: Date.now() } : item)),
    );
    curlTabStore.requestOpen(request.id);
  };

  const commitFolders = (next: readonly string[], previous: readonly string[]) => {
    if (!onUpdateFolders) return;
    if (next.length === previous.length && next.every((path, index) => path === previous[index])) return;
    void onUpdateFolders([...next]);
  };

  const expandFolder = (path: string | undefined) => {
    if (!path) return;
    for (const chainPath of [...curlFolderAncestors(path), path]) setCollapsed(chainPath, false);
  };

  const startCreateFolder = (parent?: string) => {
    setCreatingParent(parent);
    setCreating(true);
    expandFolder(parent);
  };

  const cancelCreateFolder = () => {
    setCreating(false);
    setCreatingParent(undefined);
  };

  const commitCreateFolder = (name: string, parent?: string) => {
    const path = curlFolderJoin(parent, name);
    setCreating(false);
    setCreatingParent(undefined);
    if (!path) return;
    commitFolders(sanitizeCurlFolders([...folderList, path]), folderList);
    expandFolder(path);
  };

  const renameFolder = (path: string, nextPath: string) => {
    if (!nextPath || nextPath === path) return;
    // Never move a folder into one of its own descendants, and never merge two
    // existing folders by accident (the drop/rename would silently combine them).
    if (nextPath.startsWith(`${path}/`)) return;
    if (folderList.includes(nextPath)) return;
    const nextFolders = rewriteCurlFolders(folderList, path, nextPath);
    const nextRequests = rewriteCurlRequestFolders(requests ?? [], path, nextPath);
    commitFolders(nextFolders, folderList);
    if (nextRequests.some((request, index) => request !== requests[index])) {
      void onUpdateRequests(nextRequests);
    }
    expandFolder(curlFolderParentPath(nextPath));
    setCollapsed(nextPath, false);
  };

  const confirmDeleteFolder = () => {
    if (!pendingDeleteFolder) return;
    const path = pendingDeleteFolder;
    const parent = curlFolderParentPath(path);
    const nextFolders = removeCurlFolderSubtree(folderList, path);
    const nextRequests = (requests ?? []).map((request) =>
      request.folder && curlFolderIsWithin(request.folder, path) ? { ...request, folder: parent } : request);
    commitFolders(nextFolders, folderList);
    if (nextRequests.some((request, index) => request !== requests[index])) {
      void onUpdateRequests(nextRequests);
    }
    setPendingDeleteFolder(null);
  };

  const renameRequest = (requestId: string, name: string) => {
    const next = name.trim();
    if (!next) return;
    void onUpdateRequests(
      (requests ?? []).map((request) => (request.id === requestId ? { ...request, name: next } : request)),
    );
  };

  const duplicateRequest = (request: CurlRequest) => {
    const id = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const next = duplicateCurlRequest(requests ?? [], request.id, {
      id,
      copyLabel: t('curl.requestCopyLabel'),
    });
    if (next === requests) return;
    void onUpdateRequests(next);
    expandFolder(request.folder);
  };

  const moveRequest = (requestId: string, folder: string | undefined) => {
    const target = sanitizeCurlFolderPath(folder);
    const current = (requests ?? []).find((request) => request.id === requestId);
    if (!current) return;
    if (target) {
      // Dropping onto a folder that only exists implicitly must persist it.
      commitFolders(sanitizeCurlFolders([...folderList, target]), folderList);
      expandFolder(target);
    }
    if (sanitizeCurlFolderPath(current.folder) === target) return;
    void onUpdateRequests(
      (requests ?? []).map((request) => (request.id === requestId ? { ...request, folder: target } : request)),
    );
  };

  const moveFolder = (path: string, parent: string | undefined) => {
    const nextPath = reparentCurlFolderPath(path, parent);
    if (!nextPath || folderList.includes(nextPath)) return;
    const nextFolders = rewriteCurlFolders(folderList, path, nextPath);
    const nextRequests = rewriteCurlRequestFolders(requests ?? [], path, nextPath);
    commitFolders(nextFolders, folderList);
    if (nextRequests.some((request, index) => request !== requests[index])) {
      void onUpdateRequests(nextRequests);
    }
    expandFolder(nextPath);
  };

  const isSearching = query.trim().length > 0;
  const hasContent = folderList.length > 0 || (requests ?? []).length > 0;
  const showEmpty = isSearching ? filtered.length === 0 : !hasContent;

  return (
    <div className="flex h-full flex-col">
      <VaultPageHeader>
        <Button
          variant="secondary"
          className={vaultHeaderSecondaryButtonClass}
          onClick={() => curlTabStore.requestOpen(undefined)}
        >
          <Plus size={14} />
          {t('curl.newRequest')}
        </Button>
        {onUpdateFolders ? (
          <Button
            variant="secondary"
            className={vaultHeaderSecondaryButtonClass}
            onClick={() => startCreateFolder(undefined)}
          >
            <FolderPlus size={14} />
            {t('curl.newFolder')}
          </Button>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-shrink items-center gap-2">
          <VaultHeaderSearch
            aria-label={t('curl.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('curl.searchPlaceholder')}
            className="w-64 flex-shrink"
          />
        </div>
      </VaultPageHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <h2 className={vaultSectionTitleClass}>{t('curl.title')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('curl.count', { count: String((requests ?? []).length) })}
          </span>
        </div>
        {showEmpty ? (
          <div className="flex h-64 flex-col items-center justify-center px-6 text-muted-foreground">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary/80">
              <Waypoints size={32} className="opacity-60" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-foreground">
              {isSearching ? t('curl.emptySearch') : t('curl.empty')}
            </h3>
            <p className="mb-4 max-w-sm text-center text-sm">
              {isSearching ? t('curl.emptySearchHint') : t('curl.emptyHint')}
            </p>
            {isSearching ? null : (
              <Button onClick={() => curlTabStore.requestOpen(undefined)}>
                <Plus size={14} className="mr-2" />
                {t('curl.newRequest')}
              </Button>
            )}
          </div>
        ) : isSearching ? (
          <div className="space-y-1 px-3 pb-6">
            {filtered.map((request) => (
              <div
                key={request.id}
                className="group flex items-center gap-3 rounded-md border border-transparent px-3 py-2 hover:border-border/60 hover:bg-muted/40"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => openRequest(request)}
                >
                  <span className={cn('w-16 shrink-0 font-mono text-[11px] font-semibold', CURL_METHOD_CLASS[request.method])}>
                    {request.method}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{request.name || request.url}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {request.folder ? `${request.folder} / ` : ''}
                      {request.url}
                    </span>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100"
                  aria-label={t('curl.requestDuplicate')}
                  title={t('curl.requestDuplicate')}
                  onClick={() => duplicateRequest(request)}
                >
                  <Copy size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100"
                  aria-label={t('curl.delete')}
                  onClick={() => setPendingDelete(request)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <CurlFolderTree
            folders={folderList}
            requests={requests ?? []}
            creating={creating}
            creatingParent={creatingParent}
            onStartCreateFolder={startCreateFolder}
            onCancelCreateFolder={cancelCreateFolder}
            onCommitCreateFolder={commitCreateFolder}
            onRenameFolder={renameFolder}
            onRenameRequest={renameRequest}
            onDeleteFolder={setPendingDeleteFolder}
            onMoveRequest={moveRequest}
            onMoveFolder={moveFolder}
            onOpenRequest={openRequest}
            onDeleteRequest={setPendingDelete}
            onDuplicateRequest={duplicateRequest}
          />
        )}
      </ScrollArea>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('curl.deleteConfirmTitle')}
        message={t('curl.deleteConfirmMessage', { name: pendingDelete?.name ?? pendingDelete?.url ?? '' })}
        confirmLabel={t('curl.delete')}
        destructive
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (!pendingDelete) return;
          void onUpdateRequests((requests ?? []).filter((item) => item.id !== pendingDelete.id));
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={pendingDeleteFolder !== null}
        title={t('curl.folderDeleteTitle')}
        message={t('curl.folderDeleteMessage', { name: pendingDeleteFolder ?? '' })}
        confirmLabel={t('curl.delete')}
        destructive
        onOpenChange={(open) => {
          if (!open) setPendingDeleteFolder(null);
        }}
        onConfirm={confirmDeleteFolder}
      />
    </div>
  );
};
