import pg from 'pg';

/**
 * The credential the dev stack ships with, committed on purpose.
 *
 * Its presence is also how `usesDevelopmentDefaults` recognises a development
 * database — a deployment that configured itself will not be using this string.
 */
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:dev_password_change_me@localhost:5432/xperiment';
export const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

export type Db = pg.Pool | pg.PoolClient;

/**
 * A statement that runs this long is not slow, it is stuck.
 *
 * Thirty seconds rather than something tight: the hottest contention in the suite is
 * a dozen writers racing the same quota row, and that waits tens of milliseconds. The
 * margin is about three orders of magnitude. Anything lower starts cancelling honest
 * work under load, which is worse than the hang it was meant to prevent.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export interface PoolOptions {
  statementTimeoutMs?: number;
  max?: number;
  /** Called on a pool-level error. Defaults to swallowing it — see below. */
  onError?: (error: Error) => void;
}

export function resolveDatabaseUrl(databaseUrl?: string): string {
  return databaseUrl ?? process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
}

/** Whether this process is still pointed at the committed development credential. */
export function usesDevelopmentDefaults(databaseUrl?: string): boolean {
  return resolveDatabaseUrl(databaseUrl) === DEFAULT_DATABASE_URL;
}

/**
 * The signature is unchanged on purpose — seventy call sites read it.
 *
 * `onError` is the load-bearing addition. node-postgres emits 'error' on the Pool when
 * an IDLE client's backend goes away: a failover, a restart, Docker Desktop being
 * paused. An 'error' event with no listener is an uncaught exception in Node, so a
 * blip that pg would otherwise recover from by discarding the client instead took down
 * whichever of the five services happened to be holding it.
 */
export function createPool(databaseUrl?: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: resolveDatabaseUrl(databaseUrl),
    max: options.max ?? 10,
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  });
  // Default to swallowing rather than rethrowing: pg has already removed the broken
  // client from the pool by the time this fires, and the next query gets a fresh one.
  pool.on('error', (error) => options.onError?.(error instanceof Error ? error : new Error(String(error))));
  return pool;
}
