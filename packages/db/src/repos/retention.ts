import {
  AUDIT_RETENTION_FLOOR_DAYS,
  OUTBOX_RETENTION_DAYS,
  PLAN_RETENTION,
  USAGE_RETENTION_FLOOR_DAYS,
} from '@xperiment/plans';
import type pg from 'pg';

export interface RetentionPolicy {
  /** The fallback for a workspace whose plan is unknown. A plan in PLAN_RETENTION wins. */
  executionDays: number;
  /** Likewise a fallback. See `executionDays`. */
  triggerEventDays: number;
  auditDays: number;
  usageDays: number;
  outboxDays: number;
  /** Dated by `updated_at`: a three-week-old conversation somebody is still using must
   *  not vanish mid-sentence. */
  conversationDays: number;
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
  agentConversations: number;
}

/**
 * The per-plan schedule, as parallel arrays the sweep hands to `unnest`.
 *
 * Retention is a property of the plan, not of the operator running the sweep: a free
 * workspace is entitled to seven days of run history and a business workspace to a year.
 * Before this, every workspace got whatever single number the caller passed — 30 days for
 * everyone, because the scheduler calls `pruneExpired(pool)` with no arguments at all —
 * so a free plan kept four weeks it had not paid for and a business plan lost eleven
 * months it had.
 *
 * `triggerDays` is floored at the same plan's `executionDays` for the reason `clampPolicy`
 * does it to an operator's request: an execution whose trigger event was deleted still
 * points at it, and every later sweep would unhook the same rows again. The catalog has
 * them equal today, and this keeps a future edit from quietly costing that.
 */
const PLAN_SCHEDULE = ((): { codes: string[]; executionDays: number[]; triggerDays: number[] } => {
  const codes: string[] = [];
  const executionDays: number[] = [];
  const triggerDays: number[] = [];
  for (const [code, days] of Object.entries(PLAN_RETENTION)) {
    codes.push(code);
    executionDays.push(Math.max(1, days.executionDays));
    triggerDays.push(Math.max(1, days.triggerEventDays, days.executionDays));
  }
  return { codes, executionDays, triggerDays };
})();

/**
 * The schedule the sweep will actually apply, per plan.
 *
 * Derived from PLAN_SCHEDULE rather than re-read from the catalog, so it reflects the
 * `triggerDays` floor. An operator asking what a sweep is going to do should be told what
 * it does, not what a constant says before this module gets hold of it.
 */
export function planRetentionSchedule(): Record<string, { executionDays: number; triggerEventDays: number }> {
  const out: Record<string, { executionDays: number; triggerEventDays: number }> = {};
  PLAN_SCHEDULE.codes.forEach((code, i) => {
    out[code] = {
      executionDays: PLAN_SCHEDULE.executionDays[i]!,
      triggerEventDays: PLAN_SCHEDULE.triggerDays[i]!,
    };
  });
  return out;
}

/**
 * Joins each row to its workspace's plan.
 *
 * A LEFT JOIN, and the caller's own number is the COALESCE fallback — NOT `free`.
 * `getWorkspacePlan` treats a missing row as free because spend must fail closed, but
 * deletion is the other direction: a business workspace whose plan row went missing would
 * have 358 days of history removed on the next sweep. When the plan is unknown the sweep
 * does what it did before plans were consulted, which is the conservative answer for
 * something irreversible.
 *
 * $1/$2/$3 are the schedule; $4 is the fallback in days.
 */
const PLAN_DAYS_CTE = `WITH plan_days AS (
    SELECT * FROM unnest($1::text[], $2::int[], $3::int[]) AS t(code, execution_days, trigger_days)
  )`;

const PLAN_PARAMS = [PLAN_SCHEDULE.codes, PLAN_SCHEDULE.executionDays, PLAN_SCHEDULE.triggerDays];

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
    conversationDays: Math.max(1, requested.conversationDays ?? 90),
  };
}

async function deleteBatch(client: pg.PoolClient, sql: string, params: unknown[]): Promise<number> {
  const r = await client.query(sql, params);
  return r.rowCount ?? 0;
}

/**
 * The ids this sweep will remove, chosen once.
 *
 * Chosen once and then reused, rather than repeating the `LIMIT` subquery in each
 * statement. Two statements with the same `LIMIT` and no `ORDER BY` are not obliged to
 * return the same rows — and between them an execution can cross the age threshold, so
 * the second could name a row whose open wait the first never deleted, which is a 23503.
 * Cheap to hold: the list is bounded by the batch.
 */
async function doomedIds(client: pg.PoolClient, sql: string, params: unknown[]): Promise<string[]> {
  const r = await client.query<{ id: string }>(sql, params);
  return r.rows.map((row) => row.id);
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
    agentConversations: 0,
  };
  try {
    await client.query('BEGIN');

    // Messages and credential requests cascade from the conversation, so only the parent
    // needs a batched delete. `updated_at` rather than `created_at`, because the row a
    // sweep must not take is the long conversation somebody is still in the middle of.
    result.agentConversations = await deleteBatch(
      client,
      `DELETE FROM agent_conversations WHERE id IN (
         SELECT id FROM agent_conversations WHERE updated_at < now() - make_interval(days => $1) LIMIT ${batch}
       )`,
      [policy.conversationDays],
    );

    const doomedExecutions = await doomedIds(
      client,
      `${PLAN_DAYS_CTE}
       SELECT e.id FROM executions e
       LEFT JOIN workspace_plans wp ON wp.workspace_id = e.workspace_id
       LEFT JOIN plan_days pd ON pd.code = wp.plan_code
       WHERE e.created_at < now() - make_interval(days => COALESCE(pd.execution_days, $4))
       LIMIT ${batch}`,
      [...PLAN_PARAMS, policy.executionDays],
    );

    result.executionWaits = await deleteBatch(
      client,
      `DELETE FROM execution_waits WHERE execution_id = ANY($1::uuid[])`,
      [doomedExecutions],
    );
    result.executions = await deleteBatch(
      client,
      `DELETE FROM executions WHERE id = ANY($1::uuid[])`,
      [doomedExecutions],
    );

    const doomedTriggers = await doomedIds(
      client,
      `${PLAN_DAYS_CTE}
       SELECT te.id FROM trigger_events te
       LEFT JOIN workspace_plans wp ON wp.workspace_id = te.workspace_id
       LEFT JOIN plan_days pd ON pd.code = wp.plan_code
       WHERE te.received_at < now() - make_interval(days => COALESCE(pd.trigger_days, $4))
       LIMIT ${batch}`,
      [...PLAN_PARAMS, policy.triggerEventDays],
    );

    // Unhook rather than cascade: an execution outlives the webhook body that started
    // it, and losing the run because the payload aged out would be the wrong trade.
    await client.query(`UPDATE executions SET trigger_event_id = NULL WHERE trigger_event_id = ANY($1::uuid[])`, [
      doomedTriggers,
    ]);
    result.triggerEvents = await deleteBatch(
      client,
      `DELETE FROM trigger_events WHERE id = ANY($1::uuid[])`,
      [doomedTriggers],
    );

    // Same horizon as the trigger bodies they describe, and so also per plan. A delivery
    // record is diagnostic, not evidence: keeping it past the run it explains helps nobody
    // and costs storage on the highest-volume write path in the system.
    result.webhookDeliveries = await deleteBatch(
      client,
      `${PLAN_DAYS_CTE}
       DELETE FROM webhook_deliveries WHERE id IN (
         SELECT wd.id FROM webhook_deliveries wd
         LEFT JOIN workspace_plans wp ON wp.workspace_id = wd.workspace_id
         LEFT JOIN plan_days pd ON pd.code = wp.plan_code
         WHERE wd.received_at < now() - make_interval(days => COALESCE(pd.trigger_days, $4))
         LIMIT ${batch}
       )`,
      [...PLAN_PARAMS, policy.triggerEventDays],
    );

    // Audit and usage are NOT per plan, and deliberately so. They have floors precisely
    // because no plan and no operator may shorten them: a free workspace's audit trail is
    // evidence of who did what, and its usage rows are what an invoice was computed from.
    // A plan buys longer run history, not a shorter paper trail.
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
