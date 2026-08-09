import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Arbitrary but fixed: the ASCII bytes of 'xperiment'. Every service must agree on it. */
export const MIGRATION_LOCK_KEY = 0x716c6970;

async function applyMigrations(pool: pg.Pool, dir: string): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const appliedRes = await pool.query<{ id: string }>(`SELECT id FROM schema_migrations`);
  const applied = new Set(appliedRes.rows.map((r) => r.id));
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

/**
 * Apply pending migrations, one process at a time.
 *
 * Five services call this at boot with no coordination. Unserialised, they race on the
 * DDL itself and on the `schema_migrations` primary key, and the loser crashes on a
 * conflict that says nothing about what actually happened.
 *
 * The lock is SESSION scoped and held on a dedicated client, not transaction scoped:
 * each migration file opens its own transaction, so a transaction-scoped lock would be
 * released after the first file and the rest would race exactly as before.
 *
 * Two details that are load-bearing rather than tidy:
 *
 * - `statement_timeout` cancels a WAITING `pg_advisory_lock`, because the wait is a
 *   running statement. With the pool's 30s default and five services booting at once,
 *   the four that wait would be cancelled rather than queued. This client disables it.
 * - That client is DESTROYED rather than returned to the pool. `SET statement_timeout`
 *   is session state and would otherwise follow the connection to its next borrower,
 *   silently un-capping their queries; the unlock is explicit as well, so the lock is
 *   freed immediately rather than whenever the socket closes.
 */
export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const lock = await pool.connect();
  try {
    await lock.query('SET statement_timeout = 0');
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    return await applyMigrations(pool, dir);
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    // Destroy, do not return: this connection has un-capped session state on it.
    // Verified: node-postgres issues no DISCARD or RESET on release, so both the lock
    // and the SET would otherwise be inherited by the next borrower.
    lock.release(true);
  }
}
