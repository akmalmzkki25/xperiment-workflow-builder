import {
  AUDIT_RETENTION_FLOOR_DAYS,
  OUTBOX_RETENTION_DAYS,
  USAGE_RETENTION_FLOOR_DAYS,
} from '@xperiment/plans';
import type pg from 'pg';

export interface RetentionPolicy {
  executionDays: number;
  triggerEventDays: number;
  auditDays: number;
  usageDays: number;
  outboxDays: number;
}

export interface PruneResult {
  executions: number;
  executionWaits: number;
  triggerEvents: number;
  webhookDeliveries: number;
  auditEvents: number;
  usageEvents: number;
  outbox: number;
  deadLetters: number;
}

/** Bound so one sweep cannot hold a transaction over a million rows. */
export const DEFAULT_PRUNE_BATCH = 5000;

/**
 * Clamp a requested policy to what is actually allowed.
 *
 * Audit and usage have FLOORS rather than defaults. Deleting usage early rewrites
 * invoices that have already been sent; deleting audit early destroys the record of
 * who did what, which is the whole reason the log exists. An operator asking for
 * thirty days of audit gets ninety.
 */
export function clampPolicy(requested: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    executionDays: Math.max(1, requested.executionDays ?? 30),
    // Never shorter than executions: an execution whose trigger event has been deleted
    // still points at it, and the sweep would have to null that column on every run.
    triggerEventDays: Math.max(requested.triggerEventDays ?? 30, requested.executionDays ?? 30),
    auditDays: Math.max(requested.auditDays ?? AUDIT_RETENTION_FLOOR_DAYS, AUDIT_RETENTION_FLOOR_DAYS),
    usageDays: Math.max(requested.usageDays ?? USAGE_RETENTION_FLOOR_DAYS, USAGE_RETENTION_FLOOR_DAYS),
    outboxDays: Math.max(1, requested.outboxDays ?? OUTBOX_RETENTION_DAYS),
  };
}

async function deleteBatch(client: pg.PoolClient, sql: string, params: unknown[]): Promise<number> {
  const r = await client.query(sql, params);
  return r.rowCount ?? 0;
}

/**
 * Delete rows past their retention.
 *
 * The ORDER is not cosmetic. `execution_waits.execution_id` has NO ON DELETE CASCADE
 * and the column is NOT NULL, so deleting a parent execution with an open wait fails
 * with 23503 — verified against the live catalog, not assumed from the migration. The
 * waits therefore go first, and only then the executions, whose events and nodes DO
 * cascade.
 *
 * `executions.trigger_event_id` is likewise non-cascading, but nullable, so old
 * trigger events are unhooked rather than taking execution history with them.
 */
export async function pruneExpired(
  pool: pg.Pool,
  requested: Partial<RetentionPolicy> = {},
  batch: number = DEFAULT_PRUNE_BATCH,
): Promise<PruneResult> {
  const policy = clampPolicy(requested);
  const client = await pool.connect();
  const result: PruneResult = {
    executions: 0,
    executionWaits: 0,
    triggerEvents: 0,
    webhookDeliveries: 0,
    auditEvents: 0,
    usageEvents: 0,
    outbox: 0,
    deadLetters: 0,
  };
  try {
    await client.query('BEGIN');

    const oldExecutions = `SELECT id FROM executions WHERE created_at < now() - make_interval(days => $1) LIMIT ${batch}`;

    result.executionWaits = await deleteBatch(
      client,
      `DELETE FROM execution_waits WHERE execution_id IN (${oldExecutions})`,
      [policy.executionDays],
    );
    result.executions = await deleteBatch(
      client,
      `DELETE FROM executions WHERE id IN (${oldExecutions})`,
      [policy.executionDays],
    );

    // Unhook rather than cascade: an execution outlives the webhook body that started
    // it, and losing the run because the payload aged out would be the wrong trade.
    await client.query(
      `UPDATE executions SET trigger_event_id = NULL
       WHERE trigger_event_id IN (
         SELECT id FROM trigger_events WHERE received_at < now() - make_interval(days => $1) LIMIT ${batch}
       )`,
      [policy.triggerEventDays],
    );
    result.triggerEvents = await deleteBatch(
      client,
      `DELETE FROM trigger_events WHERE id IN (
         SELECT id FROM trigger_events WHERE received_at < now() - make_interval(days => $1) LIMIT ${batch}
       )`,
      [policy.triggerEventDays],
    );

    // Same horizon as the trigger bodies they describe. A delivery record is diagnostic,
    // not evidence: keeping it past the run it explains helps nobody and costs storage on
    // the highest-volume write path in the system.
    result.webhookDeliveries = await deleteBatch(
      client,
      `DELETE FROM webhook_deliveries WHERE id IN (
         SELECT id FROM webhook_deliveries WHERE received_at < now() - make_interval(days => $1) LIMIT ${batch}
       )`,
      [policy.triggerEventDays],
    );

    result.auditEvents = await deleteBatch(
      client,
      `DELETE FROM audit_events WHERE id IN (
         SELECT id FROM audit_events WHERE created_at < now() - make_interval(days => $1) LIMIT ${batch}
       )`,
      [policy.auditDays],
    );

    // occurred_at, NOT created_at: invoicing reads occurred_at, and pruning by insert
    // time would delete a backfilled event that a sent invoice still counts.
    result.usageEvents = await deleteBatch(
      client,
      `DELETE FROM usage_events WHERE id IN (
         SELECT id FROM usage_events WHERE occurred_at < now() - make_interval(days => $1) LIMIT ${batch}
       )`,
      [policy.usageDays],
    );

    result.outbox = await deleteBatch(
      client,
      `DELETE FROM task_outbox WHERE id IN (
         SELECT id FROM task_outbox
         WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => $1) LIMIT ${batch}
       )`,
      [policy.outboxDays],
    );

    // Replayed dead letters are settled history; unreplayed ones are an open incident
    // and are never swept out from under whoever has to deal with them.
    result.deadLetters = await deleteBatch(
      client,
      `DELETE FROM outbox_dead_letters
       WHERE replayed_at IS NOT NULL AND replayed_at < now() - make_interval(days => $1)`,
      [policy.outboxDays],
    );

    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
