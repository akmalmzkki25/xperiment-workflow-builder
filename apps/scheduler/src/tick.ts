import { createExecutionWithTrigger, dueScheduleTriggers, getVersion, getWorkflow, withTx } from '@xperiment/db';
import { nextFireAt } from '@xperiment/engine-core';
import { workflowIrSchema } from '@xperiment/ir';
import type pg from 'pg';

const DEFAULT_GRACE_MS = 60000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;
const BATCH = 20;

export interface SchedulerDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  graceMs?: number;
}

export async function runSchedulerTick(deps: SchedulerDeps): Promise<{ fired: number; skipped: number }> {
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  let fired = 0;
  let skipped = 0;

  await withTx(deps.pool, async (client) => {
    const due = await dueScheduleTriggers(client, BATCH);
    const now = new Date();

    for (const trigger of due) {
      const scheduledFor = new Date(trigger.nextFireAt!);
      const tz = trigger.timezone ?? 'Asia/Jakarta';

      if (now.getTime() - scheduledFor.getTime() > graceMs) {
        skipped += 1;
        deps.log('schedule.misfire_skipped', { triggerId: trigger.id, scheduledFor: scheduledFor.toISOString() });
        await client.query(`UPDATE workflow_triggers SET next_fire_at = $1, updated_at = now() WHERE id = $2`, [
          nextFireAt(trigger.cron!, tz, now),
          trigger.id,
        ]);
        continue;
      }

      const wf = await getWorkflow(deps.pool, trigger.workflowId);
      if (!wf?.activeVersionId) continue;
      const version = await getVersion(deps.pool, wf.activeVersionId);
      if (!version) continue;
      const ir = workflowIrSchema.parse(version.definition);

      // Fires in its own transaction; if this lease tx later rolls back the
      // idempotency key makes the re-fire a no-op.
      const result = await createExecutionWithTrigger(deps.pool, {
        workflowId: trigger.workflowId,
        versionId: version.id,
        idempotencyKey: `sched:${trigger.id}:${scheduledFor.toISOString()}`,
        payload: { firedAt: now.toISOString(), scheduledFor: scheduledFor.toISOString() },
        nodeIds: ir.nodes.map((n) => n.id),
        executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      });
      if (result.outcome === 'quota_exceeded') {
        // Skip this fire but keep the sweep going, and still advance next_fire_at so a
        // blocked workspace does not accumulate a backlog that all fires at once on
        // upgrade. The managed quota alert is what notifies.
        skipped += 1;
        deps.log('schedule.quota_blocked', { triggerId: trigger.id, used: result.used, limit: result.limit });
        await client.query(`UPDATE workflow_triggers SET next_fire_at = $1, updated_at = now() WHERE id = $2`, [
          nextFireAt(trigger.cron!, tz, scheduledFor),
          trigger.id,
        ]);
        continue;
      }
      fired += 1;
      deps.log('schedule.fired', { triggerId: trigger.id, scheduledFor: scheduledFor.toISOString() });

      await client.query(`UPDATE workflow_triggers SET next_fire_at = $1, updated_at = now() WHERE id = $2`, [
        nextFireAt(trigger.cron!, tz, scheduledFor),
        trigger.id,
      ]);
    }
  });

  return { fired, skipped };
}
