import type pg from 'pg';

// Postgres SQLSTATEs worth retrying: 40P01 deadlock_detected, 40001
// serialization_failure. Both abort the whole transaction with no committed
// effects, so re-running the callback on a fresh transaction is safe. This
// covers the cancel-vs-orchestrator lock-order race (the API cancel tx and the
// orchestrator finalize tx touch execution + node rows in opposite order), which
// would otherwise surface an unhandled 500 to a cancel caller.
// 55P03 lock_not_available joins them: it is raised only by `lock_timeout`, and it
// means exactly one thing — someone else held the lock long enough. Deliberately NOT
// 57014 query_canceled, which the pool's statement_timeout also raises AND which an
// operator's pg_cancel_backend raises with the same code; retrying it would retry a
// cancellation someone asked for.
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001', '55P03']);
/** Bound an advisory-lock wait so it fails as 55P03 rather than the pool's 57014. */
export const ADVISORY_LOCK_TIMEOUT_MS = 10_000;
const MAX_TX_ATTEMPTS = 3;

export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      lastErr = e;
      const code = (e as { code?: string }).code;
      if (code && RETRYABLE_SQLSTATES.has(code) && attempt < MAX_TX_ATTEMPTS) continue;
      throw e;
    } finally {
      client.release();
    }
  }
  throw lastErr; // unreachable: the final attempt always returns or throws in the loop
}
