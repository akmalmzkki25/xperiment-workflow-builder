import type pg from 'pg';
import type { Db } from '../pool.js';

export interface OutboxRow {
  id: string;
  eventType: string;
  payload: unknown;
  delayMs: number;
  /** Claim count, incremented at lease time so a repeatedly failing row can be seen. */
  attempts: number;
  /**
   * How many times this work has been replayed out of the dead-letter table.
   *
   * Zero for an original. Non-zero rows must publish under a different BullMQ job id
   * than the original, or the replay is silently deduplicated away.
   */
  replaySeq: number;
}

export interface DeadLetterRow {
  id: string;
  outboxId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  lastError: string;
  deadAt: string;
}

/**
 * How long a claim is honoured before another publisher may take the row.
 *
 * Long enough that a slow queue write is not stolen mid-flight, short enough that a
 * publisher killed with the row in hand does not strand it for a shift.
 */
export const LEASE_MS = 60_000;

/** Claims past this many attempts stop being retried and become dead letters. */
export const MAX_PUBLISH_ATTEMPTS = 5;

export async function insertOutbox(
  db: Db,
  args: { eventType: string; payload: unknown; delayMs?: number },
): Promise<void> {
  await db.query(`INSERT INTO task_outbox (event_type, payload_json, delay_ms) VALUES ($1, $2, $3)`, [
    args.eventType,
    JSON.stringify(args.payload),
    args.delayMs ?? 0,
  ]);
}

function toRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: row['id'] as string,
    eventType: row['event_type'] as string,
    payload: row['payload_json'],
    delayMs: Number(row['delay_ms']),
    attempts: Number(row['attempts']),
    replaySeq: Number(row['replay_seq']),
  };
}

/**
 * Read pending rows WITHOUT claiming them.
 *
 * Kept separate from `claimOutbox` because inspecting a queue and taking work off it
 * are different operations: this one is for tests and health reporting and leaves the
 * lease untouched.
 */
export async function fetchUnpublished(db: Db, limit: number): Promise<OutboxRow[]> {
  const r = await db.query(
    `SELECT id, event_type, payload_json, delay_ms, attempts, replay_seq FROM task_outbox
     WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return (r.rows as Record<string, unknown>[]).map(toRow);
}

/**
 * Take exclusive ownership of a batch.
 *
 * One statement, not a SELECT followed by an UPDATE: five publishers poll this table
 * every 250ms, and a plain read hands all five the same rows. `SKIP LOCKED` lets the
 * other four step over rows already being claimed rather than queue behind them.
 *
 * A claim older than the lease is reclaimable, which is what recovers rows from a
 * publisher that died holding them. That makes delivery at-least-once, which is safe
 * because every job carries a deterministic BullMQ jobId and a redelivery is
 * deduplicated rather than run twice — but only for as long as the completed job
 * still exists in Redis. Dedup is keyed on the job hash, and `removeOnComplete`
 * deletes it after an hour. The 60s lease and the five-attempt cap put the worst-case
 * redelivery at about five minutes, comfortably inside that window; anything that
 * could republish the same work an hour later must NOT rely on this, which is why
 * dead-letter replay carries its own sequence.
 */
export async function claimOutbox(pool: pg.Pool, limit: number, leaseMs: number = LEASE_MS): Promise<OutboxRow[]> {
  const r = await pool.query(
    `UPDATE task_outbox SET claimed_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM task_outbox
       WHERE published_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $2 / 1000.0))
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, event_type, payload_json, delay_ms, attempts, replay_seq`,
    [limit, leaseMs],
  );
  return (r.rows as Record<string, unknown>[]).map(toRow);
}

export async function markPublished(pool: pg.Pool, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(`UPDATE task_outbox SET published_at = now() WHERE id = ANY($1)`, [ids]);
}

/**
 * Hand a row back for another attempt, remembering why the last one failed.
 *
 * Clearing the lease rather than waiting for it to expire: a transient queue error
 * should be retried on the next tick, not in a minute.
 */
export async function releaseOutbox(pool: pg.Pool, id: string, error: string): Promise<void> {
  await pool.query(`UPDATE task_outbox SET claimed_at = NULL, last_error = $2 WHERE id = $1`, [id, error.slice(0, 2000)]);
}

/**
 * Retire a row that will not publish.
 *
 * Deleted from the outbox in the same transaction it is recorded, so it stops being
 * re-read every 250ms by five processes and stops occupying a slot in every batch.
 */
export async function deadLetterOutbox(pool: pg.Pool, row: OutboxRow, error: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO outbox_dead_letters (outbox_id, event_type, payload_json, attempts, last_error, replay_seq)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.eventType, JSON.stringify(row.payload), row.attempts, error.slice(0, 2000), row.replaySeq],
    );
    await client.query(`DELETE FROM task_outbox WHERE id = $1`, [row.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function listDeadLetters(db: Db, limit = 100): Promise<DeadLetterRow[]> {
  const r = await db.query(
    `SELECT id, outbox_id, event_type, payload_json, attempts, last_error, dead_at
     FROM outbox_dead_letters WHERE replayed_at IS NULL ORDER BY dead_at DESC LIMIT $1`,
    [limit],
  );
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    id: row['id'] as string,
    outboxId: row['outbox_id'] as string,
    eventType: row['event_type'] as string,
    payload: row['payload_json'],
    attempts: Number(row['attempts']),
    lastError: row['last_error'] as string,
    deadAt: (row['dead_at'] as Date).toISOString(),
  }));
}

/**
 * Put a dead letter back on the outbox as a NEW row.
 *
 * Never resurrects the original: the record of the failure has to survive the fix, and
 * a replay that reuses the id would erase the evidence that it ever went wrong.
 *
 * `replay_seq` advances so the republished work publishes under a different BullMQ job
 * id. Without it the replay reproduced the original id exactly, and BullMQ deduplicates
 * silently — within the hour that the completed job survives in Redis, the replay was
 * swallowed and the work never ran, with no error anywhere. Whether a replay did
 * anything depended on how long the operator had waited.
 */
export async function replayDeadLetter(pool: pg.Pool, id: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `UPDATE outbox_dead_letters SET replayed_at = now()
       WHERE id = $1 AND replayed_at IS NULL
       RETURNING event_type, payload_json, replay_seq`,
      [id],
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const row = found.rows[0] as { event_type: string; payload_json: unknown; replay_seq: number };
    await client.query(`INSERT INTO task_outbox (event_type, payload_json, replay_seq) VALUES ($1, $2, $3)`, [
      row.event_type,
      JSON.stringify(row.payload_json),
      Number(row.replay_seq) + 1,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Rows waiting, rows stuck past the attempt cap, and dead letters not yet replayed. */
export async function outboxHealth(db: Db): Promise<{ pending: number; struggling: number; dead: number }> {
  const r = await db.query<{ pending: string; struggling: string; dead: string }>(
    `SELECT
       (SELECT count(*) FROM task_outbox WHERE published_at IS NULL) AS pending,
       (SELECT count(*) FROM task_outbox WHERE published_at IS NULL AND attempts >= $1) AS struggling,
       (SELECT count(*) FROM outbox_dead_letters WHERE replayed_at IS NULL) AS dead`,
    [MAX_PUBLISH_ATTEMPTS],
  );
  const row = r.rows[0]!;
  // node-postgres returns int8 as a string.
  return { pending: Number(row.pending), struggling: Number(row.struggling), dead: Number(row.dead) };
}
