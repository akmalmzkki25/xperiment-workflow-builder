import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { billingPeriod, BILLING_TZ } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createPool,
  createUser,
  createWorkspaceWithOwner,
  getQuotaUsage,
  getUsageSummary,
  insertUsageEvents,
  recomputeCounters,
  runMigrations,
} from '../src/index.js';

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newWorkspace(): Promise<string> {
  const user = await createUser(pool, { email: `wib-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'WIB', userId: user.id, actor: { actorKind: 'system' } });
  return ws.id;
}

const at = (iso: string) => new Date(Date.parse(iso));

async function record(workspaceId: string, occurredAt: Date, quantity = 1): Promise<void> {
  await insertUsageEvents(pool, [{ workspaceId, metric: 'execution', quantity, occurredAt }]);
}

describe('period bounds in SQL', () => {
  test('a run at 03:00 WIB on the 1st counts into that month, not the previous one', async () => {
    // This is the defect, exactly: 2026-08-01T03:00+07:00 is 2026-07-31T20:00Z, and the
    // old bound (`occurred_at >= '2026-08-01'::date`, cast in a UTC session) excluded it.
    const ws = await newWorkspace();
    await record(ws, at('2026-08-01T03:00:00+07:00'), 5);
    await recomputeCounters(pool, ws, '2026-08-01');
    expect((await getQuotaUsage(pool, ws, '2026-08-01')).executionsPerMonth).toBe(5);

    await recomputeCounters(pool, ws, '2026-07-01');
    expect((await getQuotaUsage(pool, ws, '2026-07-01')).executionsPerMonth).toBe(0);
  });

  test('a run at 23:30 WIB on the last day counts into that month, not the next', async () => {
    const ws = await newWorkspace();
    await record(ws, at('2026-08-31T23:30:00+07:00'), 3);
    await recomputeCounters(pool, ws, '2026-08-01');
    await recomputeCounters(pool, ws, '2026-09-01');
    expect((await getQuotaUsage(pool, ws, '2026-08-01')).executionsPerMonth).toBe(3);
    expect((await getQuotaUsage(pool, ws, '2026-09-01')).executionsPerMonth).toBe(0);
  });

  test('the boundary is the application decision, not the session TimeZone', async () => {
    // The old bound compared a timestamptz against a bare `::date`, which Postgres casts
    // using the session TimeZone. That made a billing boundary a server setting.
    const ws = await newWorkspace();
    await record(ws, at('2026-08-01T03:00:00+07:00'), 2);
    const seen: number[] = [];
    for (const tz of ['Etc/UTC', 'Asia/Jakarta', 'America/New_York']) {
      const client = await pool.connect();
      try {
        await client.query(`SET TIME ZONE '${tz}'`);
        await recomputeCounters(client, ws, '2026-08-01');
        seen.push((await getQuotaUsage(client, ws, '2026-08-01')).executionsPerMonth);
      } finally {
        client.release();
      }
    }
    expect(seen).toEqual([2, 2, 2]);
  });

  test('recompute is a rebuild, not an accumulation, so running it twice is safe', async () => {
    const ws = await newWorkspace();
    await record(ws, at('2026-08-10T10:00:00+07:00'), 4);
    await recomputeCounters(pool, ws, '2026-08-01');
    await recomputeCounters(pool, ws, '2026-08-01');
    expect((await getQuotaUsage(pool, ws, '2026-08-01')).executionsPerMonth).toBe(4);
  });
});

describe('the daily usage series', () => {
  test('groups by the shop owner own days, not UTC days', async () => {
    // 02:00 WIB on 12 August is 19:00 UTC on 11 August. A UTC series labels it the 11th,
    // which is a day the shop was closed.
    const ws = await newWorkspace();
    await record(ws, at('2026-08-12T02:00:00+07:00'), 1);
    const summary = await getUsageSummary(pool, {
      workspaceId: ws,
      from: at('2026-08-01T00:00:00+07:00'),
      to: at('2026-09-01T00:00:00+07:00'),
    });
    expect(summary.series.map((s) => s.date)).toEqual(['2026-08-12']);
  });
});

describe('the billing period value and the SQL agree', () => {
  test('an instant folds into the period whose key the SQL counts it under', async () => {
    const ws = await newWorkspace();
    const instant = at('2026-08-01T00:30:00+07:00');
    const period = billingPeriod(instant);
    await record(ws, instant, 9);
    await recomputeCounters(pool, ws, period.key);
    expect((await getQuotaUsage(pool, ws, period.key)).executionsPerMonth).toBe(9);
    expect(BILLING_TZ).toBe('Asia/Jakarta');
  });
});

describe('migration 0022', () => {
  /** The migration's own body, replayed against a hand-built pre-state. */
  async function replay(): Promise<void> {
    const sql = await readFile(new URL('../src/migrations/0022_billing_period_wib.sql', import.meta.url), 'utf8');
    await pool.query(sql);
  }

  test('moves a run the old UTC bounds had filed under the wrong month', async () => {
    // The narrowest real case: the workspace's FIRST EVER run was at 03:00 WIB on the
    // 1st, so July has no ledger events of its own to anchor the rebuild.
    const ws = await newWorkspace();
    await record(ws, at('2026-08-01T03:00:00+07:00'), 6);
    // The pre-state the old code would have written: counted into July.
    await pool.query(
      `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
       VALUES ($1,'2026-07-01','execution',6)
       ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = 6`,
      [ws],
    );

    await replay();

    expect((await getQuotaUsage(pool, ws, '2026-08-01')).executionsPerMonth).toBe(6);
    expect((await getQuotaUsage(pool, ws, '2026-07-01')).executionsPerMonth).toBe(0);
  });

  test('leaves a month the ledger can no longer account for alone', async () => {
    // Retention prunes usage_events after a 365-day floor. Wiping counters older than the
    // ledger would silently zero the quota of months invoiced a year ago.
    const ws = await newWorkspace();
    await record(ws, at('2026-08-10T10:00:00+07:00'), 2);
    await pool.query(
      `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
       VALUES ($1,'2024-01-01','execution',777)
       ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = 777`,
      [ws],
    );

    await replay();

    expect((await getQuotaUsage(pool, ws, '2024-01-01')).executionsPerMonth).toBe(777);
    expect((await getQuotaUsage(pool, ws, '2026-08-01')).executionsPerMonth).toBe(2);
  });

  test('a month with real activity of its own keeps exactly its own runs', async () => {
    const ws = await newWorkspace();
    await record(ws, at('2026-07-20T10:00:00+07:00'), 4);
    await record(ws, at('2026-08-01T03:00:00+07:00'), 6);
    await replay();
    expect((await getQuotaUsage(pool, ws, '2026-07-01')).executionsPerMonth).toBe(4);
    expect((await getQuotaUsage(pool, ws, '2026-08-01')).executionsPerMonth).toBe(6);
  });

  test('is idempotent: replaying it does not double a counter', async () => {
    const ws = await newWorkspace();
    await record(ws, at('2026-08-10T10:00:00+07:00'), 5);
    await replay();
    await replay();
    expect((await getQuotaUsage(pool, ws, '2026-08-01')).executionsPerMonth).toBe(5);
  });
});
