/**
 * What a database failure is called in the UI.
 *
 * The bridge reports failures in English with a code. Codes that name a stage
 * of the workbench's own doing (a cancelled run, a lost transaction, a step of
 * the on-host driver's login) get translated text; everything else is the
 * driver's or the server's own message and is shown as it came.
 */

import { formatDatabaseError, type DbBridgeError } from '../../infrastructure/services/databaseService';

type Translate = (key: string) => string;

/** Bridge error codes that deserve a translated message instead of the driver text. */
const DB_ERROR_MESSAGE_KEYS: Record<string, string> = {
  'query-cancelled': 'databases.workbench.queryCancelled',
  'query-timeout': 'databases.workbench.queryTimeout',
  'transaction-lost': 'databases.workbench.transactionLost',
  'connect-timeout': 'databases.workbench.connectTimeout',
};

/**
 * On-host driver failures: a translated line saying which stage did not work,
 * followed by the bridge's message, which carries the specifics (which step,
 * which interpreter, which library).
 */
const ON_HOST_ERROR_HEADLINE_KEYS: Record<string, string> = {
  'onhost-relay': 'databases.onhost.error.relay',
  'onhost-login-step': 'databases.onhost.error.loginStep',
  'onhost-no-shell': 'databases.onhost.error.noShell',
  'onhost-env': 'databases.onhost.error.env',
  'onhost-no-python': 'databases.onhost.error.noPython',
  'onhost-agent-start': 'databases.onhost.error.agentStart',
  'agent-exit': 'databases.onhost.error.agentExit',
  'library-missing': 'databases.onhost.error.libraryMissing',
};

function translated(t: Translate, key: string | undefined): string | null {
  if (!key) return null;
  const text = t(key);
  return text && text !== key ? text : null;
}

export function describeDatabaseError(error: DbBridgeError | undefined | null, t: Translate): string {
  const code = error?.code;
  const replacement = translated(t, code ? DB_ERROR_MESSAGE_KEYS[code] : undefined);
  if (replacement) return replacement;
  const headline = translated(t, code ? ON_HOST_ERROR_HEADLINE_KEYS[code] : undefined);
  if (headline) return error?.message ? `${headline}\n${error.message}` : headline;
  return formatDatabaseError(error);
}

/**
 * A failed connect or connection test. Only codes explained above change the
 * text: a driver's own code (a SQLSTATE, ECONNREFUSED) says nothing its
 * message did not already say.
 */
export function describeDatabaseConnectFailure(
  result: { error?: string; errorCode?: string },
  t: Translate,
  fallback: string,
): string {
  const message = result.error || fallback;
  const code = result.errorCode;
  if (code && (DB_ERROR_MESSAGE_KEYS[code] || ON_HOST_ERROR_HEADLINE_KEYS[code])) {
    return describeDatabaseError({ message, code }, t);
  }
  return message;
}
