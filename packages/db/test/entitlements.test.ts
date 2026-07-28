import { randomUUID } from 'node:crypto';
import { periodStart } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createPool,
  createUser,
  createWorkspaceWithOwner,
  getQuotaUsage,
  getWorkspacePlan,
  incrementUsageCounter,
  insertUsageEvents,
  listAlertRules,
  recomputeCounters,
  runMigrations,
  setWorkspacePlan,
} from '../src/index.js';

let pool: Pool;
const period = periodStart(new Date());

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newWorkspace(): Promise<string> {
  const user = await createUser(pool, { email: `p-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Plan', userId: user!.id });
  return ws.id;
}

describe('workspace plans', () => {
  test('a new workspace starts on free with overage off', async () => {
    const plan = await getWorkspacePlan(pool, await newWorkspace());
    expect(plan).toMatchObject({ planCode: 'free', allowOverage: false, limitOverrides: {} });
  });

  test('a workspace with no row reads as free rather than unlimited', async () => {
    const id = await newWorkspace();
    await pool.query(`DELETE FROM workspace_plans WHERE workspace_id = $1`, [id]);
    expect((await getWorkspacePlan(pool, id)).planCode).toBe('free');
  });

  test('setWorkspacePlan updates only what it is given', async () => {
    const id = await newWorkspace();
    expect((await setWorkspacePlan(pool, { workspaceId: id, planCode: 'team' })).planCode).toBe('team');
    const after = await setWorkspacePlan(pool, { workspaceId: id, allowOverage: true });
    expect(after).toMatchObject({ planCode: 'team', allowOverage: true });
  });

  test('a new workspace gets exactly one managed quota rule', async () => {
    const rules = await listAlertRules(pool, await newWorkspace());
    const managed = rules.filter((r) => r.managed);
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({ type: 'quota', enabled: true });
  });
});

describe('usage counters', () => {
  test('increments accumulate on one row per workspace/period/metric', async () => {
    const id = await newWorkspace();
    await incrementUsageCounter(pool, { workspaceId: id, periodStart: period, metric: 'execution', quantity: 1 });
    await incrementUsageCounter(pool, { workspaceId: id, periodStart: period, metric: 'execution', quantity: 4 });
    await incrementUsageCounter(pool, { workspaceId: id, periodStart: period, metric: 'ai_tokens', quantity: 250 });
    const usage = await getQuotaUsage(pool, id, period);
    expect(usage.executionsPerMonth).toBe(5);
    expect(usage.aiTokensPerMonth).toBe(250);
  });

  test('counters are scoped to the workspace', async () => {
    const [a, b] = [await newWorkspace(), await newWorkspace()];
    await incrementUsageCounter(pool, { workspaceId: a, periodStart: period, metric: 'execution', quantity: 7 });
    expect((await getQuotaUsage(pool, b, period)).executionsPerMonth).toBe(0);
  });

  test('a non-positive quantity is a no-op', async () => {
    const id = await newWorkspace();
    await incrementUsageCounter(pool, { workspaceId: id, periodStart: period, metric: 'execution', quantity: 0 });
    expect((await getQuotaUsage(pool, id, period)).executionsPerMonth).toBe(0);
  });

  test('gauges count live rows, not ledger history', async () => {
    const id = await newWorkspace();
    const usage = await getQuotaUsage(pool, id, period);
    expect(usage.members).toBe(1); // the owner
    expect(usage.activeWorkflows).toBe(0);
  });

  test('recomputeCounters rebuilds exactly what the ledger says', async () => {
    const id = await newWorkspace();
    await incrementUsageCounter(pool, { workspaceId: id, periodStart: period, metric: 'execution', quantity: 999 });
    await insertUsageEvents(pool, [
      { workspaceId: id, metric: 'execution', quantity: 1, occurredAt: new Date() },
      { workspaceId: id, metric: 'execution', quantity: 1, occurredAt: new Date() },
      { workspaceId: id, metric: 'ai_tokens', quantity: 40, occurredAt: new Date() },
    ]);
    await recomputeCounters(pool, id, period);
    const usage = await getQuotaUsage(pool, id, period);
    expect(usage.executionsPerMonth).toBe(2);
    expect(usage.aiTokensPerMonth).toBe(40);
  });
});
