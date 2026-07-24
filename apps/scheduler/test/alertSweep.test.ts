import { createAlertRule, createPool, insertUsageEvents, listAlertEvents, runMigrations } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runAlertSweep } from '../src/alertSweep.js';

const WS = '00000000-0000-0000-0000-000000000001';
let pool: Pool;
const deps = () => ({ pool, log: () => {} });

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE alert_events, alert_rules, usage_events, task_outbox CASCADE`);
});

async function seedRuns(succeeded: number, failed: number): Promise<void> {
  const rows = [];
  for (let i = 0; i < succeeded; i += 1)
    rows.push({ workspaceId: WS, metric: 'execution' as const, quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: new Date() });
  for (let i = 0; i < failed; i += 1)
    rows.push({ workspaceId: WS, metric: 'execution' as const, quantity: 1, metadata: { status: 'FAILED' }, occurredAt: new Date() });
  await insertUsageEvents(pool, rows);
}

describe('runAlertSweep', () => {
  test('fires a failure_rate rule when the breach holds, once per cooldown', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'fr',
      type: 'failure_rate',
      params: { windowMinutes: 60, threshold: 0.5, minSample: 2 },
      cooldownMinutes: 60,
    });
    await seedRuns(1, 3); // 3/4 = 0.75 >= 0.5, total 4 >= minSample 2
    const first = await runAlertSweep(deps());
    expect(first.fired).toBe(1);
    expect((await listAlertEvents(pool, WS, 10)).length).toBe(1);
    const second = await runAlertSweep(deps()); // within cooldown → no re-fire
    expect(second.fired).toBe(0);
    expect((await listAlertEvents(pool, WS, 10)).length).toBe(1);
  });

  test('does not fire below the min-sample guard', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'fr',
      type: 'failure_rate',
      params: { windowMinutes: 60, threshold: 0.5, minSample: 5 },
    });
    await seedRuns(0, 1); // 1/1 = 1.0 >= 0.5 BUT total 1 < minSample 5
    expect((await runAlertSweep(deps())).fired).toBe(0);
  });

  test('fires a usage_threshold rule when the metric sum crosses the threshold', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'ut',
      type: 'usage_threshold',
      params: { windowMinutes: 60, metric: 'ai_tokens', threshold: 100 },
    });
    await insertUsageEvents(pool, [{ workspaceId: WS, metric: 'ai_tokens', quantity: 150, occurredAt: new Date() }]);
    expect((await runAlertSweep(deps())).fired).toBe(1);
  });
});
