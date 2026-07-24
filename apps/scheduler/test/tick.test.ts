import {
  createPool,
  createVersion,
  createWorkflow,
  listTriggers,
  runMigrations,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
} from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runSchedulerTick } from '../src/tick.js';

let pool: Pool;
let workflowId: string;

const cronIr = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_cron', name: 'Cron' },
  entrypoints: ['tick'],
  nodes: [
    {
      id: 'tick',
      kind: 'trigger',
      type: 'schedule.trigger',
      operationVersion: '0.1.0',
      parameters: { cron: '* * * * * *' },
    },
    {
      id: 'echo',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: { ok: true } },
    },
  ],
  edges: [{ id: 'e1', from: { nodeId: 'tick', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
};

const deps = () => ({ pool, log: () => {} });

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
  const wf = await createWorkflow(pool, { name: 'Cron' });
  workflowId = wf.id;
  await createVersion(pool, { workflowId, definition: cronIr, hash: 'h' });
  await setWorkflowActive(pool, workflowId, true);
});

async function seedSchedule(nextFireAt: Date): Promise<string> {
  const row = await upsertTrigger(pool, {
    workflowId,
    nodeId: 'tick',
    type: 'schedule',
    cron: '* * * * * *', // every second (6-field)
    timezone: 'UTC',
    nextFireAt,
  });
  await setTriggersActive(pool, workflowId, true);
  return row.id;
}

describe('runSchedulerTick', () => {
  test('fires a due trigger once and advances next_fire_at', async () => {
    await seedSchedule(new Date(Date.now() - 500));
    const r1 = await runSchedulerTick(deps());
    expect(r1.fired).toBe(1);
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(1);
    const trig = (await listTriggers(pool, workflowId))[0]!;
    expect(new Date(trig.nextFireAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('re-running a tick for the same scheduledFor does not double-fire (idempotency)', async () => {
    const due = new Date(Date.now() - 500);
    await seedSchedule(due);
    await runSchedulerTick(deps());
    // Force the same scheduledFor back into the due set to simulate a crashed tick.
    await pool.query(`UPDATE workflow_triggers SET next_fire_at = $1 WHERE workflow_id = $2`, [due, workflowId]);
    const r2 = await runSchedulerTick(deps());
    expect(r2.fired).toBe(1); // it "fires" again but…
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(1); // …the idempotency key dedupes
  });

  test('misfire beyond grace is skipped forward without firing', async () => {
    await seedSchedule(new Date(Date.now() - 10 * 60_000)); // 10 minutes late
    const r = await runSchedulerTick({ ...deps(), graceMs: 60000 });
    expect(r).toEqual({ fired: 0, skipped: 1 });
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(0);
    const trig = (await listTriggers(pool, workflowId))[0]!;
    expect(new Date(trig.nextFireAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('inactive or future triggers are untouched', async () => {
    await seedSchedule(new Date(Date.now() + 3600_000));
    expect(await runSchedulerTick(deps())).toEqual({ fired: 0, skipped: 0 });
    await pool.query(`UPDATE workflow_triggers SET active = false, next_fire_at = now() - interval '1 second'`);
    expect(await runSchedulerTick(deps())).toEqual({ fired: 0, skipped: 0 });
  });

  test('due trigger on an unpublished workflow is skipped without firing', async () => {
    const bare = await createWorkflow(pool, { name: 'NoVersion' });
    await setWorkflowActive(pool, bare.id, true);
    await upsertTrigger(pool, {
      workflowId: bare.id,
      nodeId: 'tick',
      type: 'schedule',
      cron: '* * * * * *',
      timezone: 'UTC',
      nextFireAt: new Date(Date.now() - 500),
    });
    await setTriggersActive(pool, bare.id, true);
    const r = await runSchedulerTick(deps());
    expect(r.fired).toBe(0);
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(0);
  });

  test('null timezone falls back to the default and still fires', async () => {
    const row = await upsertTrigger(pool, {
      workflowId,
      nodeId: 'tick',
      type: 'schedule',
      cron: '* * * * * *',
      nextFireAt: new Date(Date.now() - 500),
    });
    await setTriggersActive(pool, workflowId, true);
    expect(row.timezone).toBeNull();
    const r = await runSchedulerTick(deps());
    expect(r.fired).toBe(1);
  });

  test('two concurrent ticks fire exactly once total', async () => {
    await seedSchedule(new Date(Date.now() - 500));
    const [a, b] = await Promise.all([runSchedulerTick(deps()), runSchedulerTick(deps())]);
    expect(a.fired + b.fired).toBe(1); // SKIP LOCKED gives the row to one tick only
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(1);
  });
});
