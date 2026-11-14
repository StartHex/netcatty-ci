import type { DatabaseConnection } from '../models/database';

/** Idle time before the workbench checks that a connection is still alive. */
export const CONNECTION_IDLE_PROBE_MS = 60_000;
/** How often idle connections are re-checked. */
export const CONNECTION_PROBE_INTERVAL_MS = 15_000;

/**
 * The on-host driver is asked whether its session to the host still answers
 * instead of being sent a statement: the client libraries on the host front
 * several database engines, and no single "select 1" is valid for all of them.
 * The driver recognises this exact text (PING_SQL in
 * electron/bridges/dbAgent/onHostSession.cjs).
 */
export const ON_HOST_PING_SQL = '/* netcatty:ping */';

/**
 * Cheapest statement that proves the session still round-trips. VPN drops and
 * idle server-side timeouts otherwise surface as a failed user query with no
 * hint that the connection died minutes earlier.
 */
export function connectivityProbeSql(kind: DatabaseConnection['kind'] | undefined): string {
  if (kind === 'oracle') return 'select 1 from dual';
  if (kind === 'onhost') return ON_HOST_PING_SQL;
  return 'select 1';
}
