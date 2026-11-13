import { CurlClientMount, DatabaseWorkbenchMount, NoteTabsMount, LogViewWrapper, SftpViewMount, TerminalLayerMount, VaultViewContainer } from '../AppMounts';

/** Lazy mount wrappers — stable module identity for the app lifetime. */
export const APP_MOUNTS_DOMAIN = Object.freeze({
  VaultViewContainer,
  SftpViewMount,
  TerminalLayerMount,
  LogViewWrapper,
  DatabaseWorkbenchMount,
  CurlClientMount,
  NoteTabsMount,
});
