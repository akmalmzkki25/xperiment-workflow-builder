import { randomUUID } from 'node:crypto';
import { periodStart } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createExecutionWithTrigger,
  createPool,
  createUser,
  createVersion,
  createWorkflow,
  createWorkspaceWithOwner,
  getQuotaUsage,
  runMigrations,
  setWorkspacePlan,
  updateDraft,
} from '../src/index.js';

let pool: Pool;
const period = periodStart(new Date());

const IR = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_q', name: 'Q' },
  entrypoints: ['t'],
  nodes: [{ id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} }],
  edges: [],
};

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

interface Seeded {
  workflowId: string;
  versionId: string;
  workspaceId: string;
}

/** A workspace holding one published workflow, with `executionsPerMonth` forced to `cap`. */
async function seeded(cap: number): Promise<Seeded> {
  const user = await createUser(pool, { email: `q-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Q', userId: user!.id });
  const wf = await createWorkflow(pool, { workspaceId: ws.id, name: 'Q' });
  await updateDraft(pool, { workflowId: wf.id, definition: IR, expectedRevision: 1 });
  // The hash is opaque here — @xperiment/db deliberately does not depend on @xperiment/ir.
  const version = await createVersion(pool, { workflowId: wf.id, definition: IR, hash: `h-${randomUUID()}` });
  await pool.query(`UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`, [
    ws.id,
    JSON.stringify({ executionsPerMonth: cap }),
  ]);
  return { workflowId: wf.id, versionId: version.id, workspaceId: ws.id };
}

const create = (s: Seeded, key: string) =>
  createExecutionWithTrigger(pool, {
    workflowId: s.workflowId,
    versionId: s.versionId,
    idempotencyKey: key,
    payload: null,
    nodeIds: ['t'],
    executionTimeoutMs: 60_000,
  });

describe('execution quota', () => {
  test('creations under the cap succeed and increment the counter', async () => {
    const s = await seeded(3);
    expect((await create(s, 'a')).outcome).toBe('created');
    expect((await create(s, 'b')).outcome).toBe('created');
    expect((await getQuotaUsage(pool, s.workspaceId, period)).executionsPerMonth).toBe(2);
  });

  test('the creation at the cap is refused with the offending numbers', async () => {
    const s = await seeded(1);
    expect((await create(s, 'a')).outcome).toBe('created');
    const blocked = await create(s, 'b');
    expect(blocked).toMatchObject({ outcome: 'quota_exceeded', metric: 'executionsPerMonth', used: 1, limit: 1 });
  });

  test('a refusal does not consume quota', async () => {
    const s = await seeded(1);
    await create(s, 'a');
    await create(s, 'b');
    await create(s, 'c');
    expect((await getQuotaUsage(pool, s.workspaceId, period)).executionsPerMonth).toBe(1);
  });

  test('a duplicate idempotency key is free', async () => {
    const s = await seeded(5);
    expect((await create(s, 'same')).outcome).toBe('created');
    expect((await create(s, 'same')).outcome).toBe('duplicate');
    expect((await getQuotaUsage(pool, s.workspaceId, period)).executionsPerMonth).toBe(1);
  });

  test('overage permits the creation and keeps counting', async () => {
    const s = await seeded(1);
    await setWorkspacePlan(pool, { workspaceId: s.workspaceId, allowOverage: true });
    expect((await create(s, 'a')).outcome).toBe('created');
    expect((await create(s, 'b')).outcome).toBe('created');
    expect((await getQuotaUsage(pool, s.workspaceId, period)).executionsPerMonth).toBe(2);
  });

  test('an unlimited plan never refuses', async () => {
    const s = await seeded(1);
    await setWorkspacePlan(pool, { workspaceId: s.workspaceId, planCode: 'business' });
    await pool.query(`UPDATE workspace_plans SET limit_overrides = '{}'::jsonb WHERE workspace_id = $1`, [
      s.workspaceId,
    ]);
    for (const k of ['a', 'b', 'c']) expect((await create(s, k)).outcome).toBe('created');
  });

  test('a refusal leaves no trigger event behind', async () => {
    const s = await seeded(0);
    expect((await create(s, 'refused')).outcome).toBe('quota_exceeded');
    const rows = await pool.query(
      `SELECT count(*)::int AS c FROM trigger_events WHERE workflow_id=$1 AND idempotency_key='refused'`,
      [s.workflowId],
    );
    // A committed orphan would poison this key: the replay below finds a trigger event
    // with no execution, and every later attempt 500s instead of running the work.
    expect((rows.rows[0] as { c: number }).c).toBe(0);
  });

  test('a key refused for quota runs once the cap is lifted', async () => {
    const s = await seeded(0);
    expect((await create(s, 'later')).outcome).toBe('quota_exceeded');
    await pool.query(`UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`, [
      s.workspaceId,
      JSON.stringify({ executionsPerMonth: 10 }),
    ]);
    expect((await create(s, 'later')).outcome).toBe('created');
  });

  test('an orphan trigger event is adopted rather than crashing the replay', async () => {
    const s = await seeded(10);
    // Simulate an orphan left by any cause (an older build, a crash between statements).
    await pool.query(
      `INSERT INTO trigger_events (workspace_id, workflow_id, idempotency_key, payload_json)
       VALUES ($1,$2,'orphan','null'::jsonb)`,
      [s.workspaceId, s.workflowId],
    );
    const result = await create(s, 'orphan');
    expect(result.outcome).toBe('created');
    const rows = await pool.query(
      `SELECT count(*)::int AS c FROM trigger_events WHERE workflow_id=$1 AND idempotency_key='orphan'`,
      [s.workflowId],
    );
    expect((rows.rows[0] as { c: number }).c).toBe(1); // adopted, not duplicated
  });

  // The M lesson: a sequential version of this passes against a broken guard.
  test('parallel creations at the boundary cannot exceed the cap', async () => {
    const s = await seeded(5);
    // Warm the pool, or the later calls spend their head start opening sockets and
    // the transactions never actually overlap.
    await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')));

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => create(s, `p${i}`)));
    const created = results.filter((r) => r.outcome === 'created');
    const refused = results.filter((r) => r.outcome === 'quota_exceeded');
    expect(created).toHaveLength(5);
    expect(refused).toHaveLength(7);
    expect((await getQuotaUsage(pool, s.workspaceId, period)).executionsPerMonth).toBe(5);
  }, 30000);
});
