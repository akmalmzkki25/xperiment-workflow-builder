import type pg from 'pg';
import type { Db } from '../pool.js';

export interface OutboxRow {
  id: string;
  eventType: string;
  payload: unknown;
  delayMs: number;
}

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

export async function fetchUnpublished(pool: pg.Pool, limit: number): Promise<OutboxRow[]> {
  const r = await pool.query(
    `SELECT id, event_type, payload_json, delay_ms FROM task_outbox
     WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    id: row['id'] as string,
    eventType: row['event_type'] as string,
    payload: row['payload_json'],
    delayMs: Number(row['delay_ms']),
  }));
}

export async function markPublished(pool: pg.Pool, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(`UPDATE task_outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1)`, [
    ids,
  ]);
}
