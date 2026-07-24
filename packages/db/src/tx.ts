import type pg from 'pg';

// Postgres SQLSTATEs worth retrying: 40P01 deadlock_detected, 40001
// serialization_failure. Both abort the whole transaction with no committed
// effects, so re-running the callback on a fresh transaction is safe. This
// covers the cancel-vs-orchestrator lock-order race (the API cancel tx and the
// orchestrator finalize tx touch execution + node rows in opposite order), which
// would otherwise surface an unhandled 500 to a cancel caller.
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
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
