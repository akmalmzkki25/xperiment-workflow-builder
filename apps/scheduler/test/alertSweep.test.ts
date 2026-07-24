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

  test('does not fire when the failure rate is below the threshold', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'fr',
      type: 'failure_rate',
      params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
    });
    await seedRuns(9, 1); // 1/10 = 0.1 < 0.5, total 10 >= minSample
    expect((await runAlertSweep(deps())).fired).toBe(0);
  });

  test('does not fire a usage_threshold rule below its threshold', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'ut',
      type: 'usage_threshold',
      params: { windowMinutes: 60, metric: 'ai_tokens', threshold: 1000 },
    });
    await insertUsageEvents(pool, [{ workspaceId: WS, metric: 'ai_tokens', quantity: 150, occurredAt: new Date() }]);
    expect((await runAlertSweep(deps())).fired).toBe(0);
  });

  test('uses default window/threshold when params are missing (no fire without data)', async () => {
    // A rule created directly with empty params exercises the num() defaults.
    await createAlertRule(pool, { workspaceId: WS, name: 'bare', type: 'usage_threshold', params: {} });
    expect((await runAlertSweep(deps())).fired).toBe(0); // threshold defaults to Infinity → never fires
  });

  test('fires at the exact boundaries (observed == threshold, total == minSample)', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'ut-eq',
      type: 'usage_threshold',
      params: { windowMinutes: 60, metric: 'ai_tokens', threshold: 100 },
    });
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'fr-eq',
      type: 'failure_rate',
      params: { windowMinutes: 60, threshold: 0.5, minSample: 2 },
    });
    await insertUsageEvents(pool, [{ workspaceId: WS, metric: 'ai_tokens', quantity: 100, occurredAt: new Date() }]); // == threshold
    await seedRuns(1, 1); // total exactly == minSample 2, rate 0.5 == threshold
    expect((await runAlertSweep(deps())).fired).toBe(2); // both boundary-equal rules fire
  });

  test('a fired rule re-fires once its cooldown has elapsed', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'fr',
      type: 'failure_rate',
      params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
      cooldownMinutes: 60,
    });
    await seedRuns(0, 2);
    expect((await runAlertSweep(deps())).fired).toBe(1);
    expect((await runAlertSweep(deps())).fired).toBe(0); // within cooldown
    await pool.query(`UPDATE alert_rules SET last_fired_at = now() - interval '2 hours'`);
    expect((await runAlertSweep(deps())).fired).toBe(1); // cooldown elapsed → re-fires
  });

  test('concurrent sweeps fire a due rule exactly once (FOR UPDATE SKIP LOCKED)', async () => {
    await createAlertRule(pool, {
      workspaceId: WS,
      name: 'fr',
      type: 'failure_rate',
      params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
    });
    await seedRuns(0, 3);
    const [a, b] = await Promise.all([runAlertSweep(deps()), runAlertSweep(deps())]);
    expect(a.fired + b.fired).toBe(1); // one sweep wins, the other skips the locked row
    expect((await listAlertEvents(pool, WS, 10)).length).toBe(1);
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
