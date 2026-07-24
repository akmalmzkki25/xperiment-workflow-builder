import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, getUsageSummary, insertUsageEvents, recordAiUsage, recordExecutionUsage, runMigrations } from '../src/index.js';

const WS = '00000000-0000-0000-0000-000000000001'; // migration-seeded default workspace
let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE usage_events`);
});

const at = (iso: string) => new Date(iso);

describe('recordExecutionUsage', () => {
  test('writes execution + node + compute rows, omitting zero-quantity rows', async () => {
    await recordExecutionUsage(pool, {
      workspaceId: WS, workflowId: WS, executionId: WS,
      status: 'SUCCEEDED', nodeCount: 3, computeMs: 1200, occurredAt: at('2026-07-10T00:00:00Z'),
    });
    await recordExecutionUsage(pool, {
      workspaceId: WS, workflowId: WS, executionId: WS,
      status: 'CANCELED', nodeCount: 0, computeMs: 0, occurredAt: at('2026-07-10T00:00:00Z'),
    });
    const rows = await pool.query(`SELECT metric FROM usage_events`);
    // run 1: execution+node+compute; run 2: execution only (0-qty node/compute omitted)
    const metrics = (rows.rows as { metric: string }[]).map((r) => r.metric).sort();
    expect(metrics).toEqual(['compute_ms', 'execution', 'execution', 'node']);
  });
});

describe('recordAiUsage', () => {
  test('writes one ai_tokens row and skips zero tokens', async () => {
    await recordAiUsage(pool, { workspaceId: WS, tokens: 350, model: 'm', kind: 'generate' });
    await recordAiUsage(pool, { workspaceId: WS, tokens: 0, model: 'm', kind: 'edit' });
    const rows = await pool.query(`SELECT quantity FROM usage_events WHERE metric='ai_tokens'`);
    expect(rows.rowCount).toBe(1);
    expect(Number((rows.rows[0] as { quantity: string }).quantity)).toBe(350);
  });
});

describe('getUsageSummary', () => {
  test('aggregates totals and daily series within the period, tenant-scoped', async () => {
    const other = '00000000-0000-0000-0000-000000000009';
    // Seed the other workspace so the FK is satisfiable for its usage row.
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1,'Other') ON CONFLICT (id) DO NOTHING`, [other]);
    await insertUsageEvents(pool, [
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: at('2026-07-10T01:00:00Z') },
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'FAILED' }, occurredAt: at('2026-07-11T01:00:00Z') },
      { workspaceId: WS, metric: 'node', quantity: 4, occurredAt: at('2026-07-10T01:00:00Z') },
      { workspaceId: WS, metric: 'compute_ms', quantity: 500, occurredAt: at('2026-07-10T01:00:00Z') },
      { workspaceId: WS, metric: 'ai_tokens', quantity: 90, occurredAt: at('2026-07-10T02:00:00Z') },
      { workspaceId: other, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: at('2026-07-10T01:00:00Z') },
    ]);
    const s = await getUsageSummary(pool, { workspaceId: WS, from: at('2026-07-01T00:00:00Z'), to: at('2026-08-01T00:00:00Z') });
    expect(s.totals).toEqual({ executions: 2, succeeded: 1, failed: 1, nodes: 4, computeMs: 500, aiTokens: 90 });
    expect(s.series.map((d) => d.date)).toEqual(['2026-07-10', '2026-07-11']);
    expect(s.series[0]).toMatchObject({ date: '2026-07-10', executions: 1, nodes: 4, computeMs: 500, aiTokens: 90 });
  });

  test('applies a half-open window and buckets days in UTC at boundaries', async () => {
    const from = at('2026-09-01T00:00:00Z');
    const to = at('2026-10-01T00:00:00Z');
    await insertUsageEvents(pool, [
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: from }, // exactly from → included
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: to }, // exactly to → excluded (half-open)
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: at('2026-09-15T23:59:59Z') }, // late UTC → stays on the 15th
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: at('2026-09-16T00:00:30Z') }, // just past midnight → the 16th
    ]);
    const s = await getUsageSummary(pool, { workspaceId: WS, from, to });
    expect(s.totals.executions).toBe(3); // the row exactly at `to` is excluded
    const days = s.series.map((d) => d.date);
    expect(days).toContain('2026-09-01');
    expect(days).toContain('2026-09-15'); // 23:59:59Z is NOT shifted into the 16th
    expect(days).toContain('2026-09-16');
    expect(days).not.toContain('2026-10-01'); // excluded by `< to`
  });

  test('empty period returns zeroed totals and empty series', async () => {
    const s = await getUsageSummary(pool, { workspaceId: WS, from: at('2026-01-01T00:00:00Z'), to: at('2026-01-02T00:00:00Z') });
    expect(s.totals).toEqual({ executions: 0, succeeded: 0, failed: 0, nodes: 0, computeMs: 0, aiTokens: 0 });
    expect(s.series).toEqual([]);
  });
});
