import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  acknowledgeAlert,
  countUnacknowledgedAlerts,
  createAlertRule,
  createPool,
  deleteAlertRule,
  dueAlertRules,
  evaluateFailureRate,
  evaluateUsageMetric,
  fireAlert,
  getAlertEventById,
  getAlertRule,
  getAlertWebhook,
  insertUsageEvents,
  listAlertEvents,
  listAlertRules,
  runMigrations,
  updateAlertRule,
  withTx,
} from '../src/index.js';

const WS = '00000000-0000-0000-0000-000000000001';
let pool: Pool;

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

const rule = () =>
  createAlertRule(pool, {
    workspaceId: WS,
    name: 'r',
    type: 'failure_rate',
    params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
  });

describe('alert rule CRUD', () => {
  test('create/list/get/update/delete round-trip, tenant-scoped', async () => {
    const r = await rule();
    expect(r.enabled).toBe(true);
    expect((await listAlertRules(pool, WS)).map((x) => x.id)).toContain(r.id);
    expect(await getAlertRule(pool, r.id, WS)).not.toBeNull();
    expect(await getAlertRule(pool, r.id, '00000000-0000-0000-0000-0000000000ff')).toBeNull();
    const upd = await updateAlertRule(pool, r.id, WS, { enabled: false, cooldownMinutes: 30 });
    expect(upd?.enabled).toBe(false);
    expect(upd?.cooldownMinutes).toBe(30);
    expect(await deleteAlertRule(pool, r.id, WS)).toBe(true);
    expect(await getAlertRule(pool, r.id, WS)).toBeNull();
  });
});

describe('evaluation queries', () => {
  test('evaluateFailureRate counts execution rows by status in the window', async () => {
    const now = new Date();
    await insertUsageEvents(pool, [
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: now },
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'FAILED' }, occurredAt: now },
      { workspaceId: WS, metric: 'execution', quantity: 1, metadata: { status: 'FAILED' }, occurredAt: now },
    ]);
    const r = await evaluateFailureRate(pool, { workspaceId: WS, windowStart: new Date(Date.now() - 3_600_000) });
    expect(r).toEqual({ total: 3, failed: 2 });
  });

  test('evaluateUsageMetric sums a metric in the window', async () => {
    await insertUsageEvents(pool, [
      { workspaceId: WS, metric: 'ai_tokens', quantity: 100, occurredAt: new Date() },
      { workspaceId: WS, metric: 'ai_tokens', quantity: 50, occurredAt: new Date() },
    ]);
    expect(
      await evaluateUsageMetric(pool, { workspaceId: WS, metric: 'ai_tokens', windowStart: new Date(Date.now() - 3_600_000) }),
    ).toBe(150);
  });
});

describe('dueAlertRules + fireAlert', () => {
  test('a rule is due until fired, then not until cooldown elapses', async () => {
    const r = await rule();
    await withTx(pool, async (c) => {
      const due = await dueAlertRules(c);
      expect(due.map((x) => x.id)).toContain(r.id);
    });
    await withTx(pool, async (c) => {
      const due = await dueAlertRules(c);
      const target = due.find((x) => x.id === r.id)!;
      await fireAlert(c, { rule: target, detail: { type: 'failure_rate', observed: 1, threshold: 0.5 }, firedAt: new Date() });
    });
    await withTx(pool, async (c) => {
      const due = await dueAlertRules(c);
      expect(due.map((x) => x.id)).not.toContain(r.id); // within cooldown → not due
    });
    expect((await listAlertEvents(pool, WS, 10)).length).toBe(1);
    expect(await countUnacknowledgedAlerts(pool, WS)).toBe(1);
  });

  test('fireAlert enqueues an alert.notify outbox row only when a webhook is set', async () => {
    const noHook = await rule();
    await withTx(pool, async (c) => {
      await fireAlert(c, { rule: noHook, detail: {}, firedAt: new Date() });
    });
    let cnt = await pool.query(`SELECT count(*)::int AS c FROM task_outbox WHERE event_type='alert.notify'`);
    expect((cnt.rows[0] as { c: number }).c).toBe(0);

    const withHook = await createAlertRule(pool, {
      workspaceId: WS,
      name: 'w',
      type: 'failure_rate',
      params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
      webhookUrl: 'https://example.com/a',
      webhookSecretEncrypted: Buffer.from([1, 2, 3]),
    });
    await withTx(pool, async (c) => {
      await fireAlert(c, { rule: withHook, detail: {}, firedAt: new Date() });
    });
    cnt = await pool.query(`SELECT count(*)::int AS c FROM task_outbox WHERE event_type='alert.notify'`);
    expect((cnt.rows[0] as { c: number }).c).toBe(1);
    expect(await getAlertWebhook(pool, withHook.id)).not.toBeNull();
  });
});

describe('acknowledgeAlert', () => {
  test('ack drops the unacknowledged count', async () => {
    const r = await rule();
    await withTx(pool, async (c) => {
      await fireAlert(c, { rule: r, detail: {}, firedAt: new Date() });
    });
    const ev = (await listAlertEvents(pool, WS, 10))[0]!;
    expect(await acknowledgeAlert(pool, ev.id, WS)).toBe(true);
    expect(await countUnacknowledgedAlerts(pool, WS)).toBe(0);
  });

  test('a second ack on an already-acknowledged event returns false (idempotent)', async () => {
    const r = await rule();
    await withTx(pool, async (c) => {
      await fireAlert(c, { rule: r, detail: {}, firedAt: new Date() });
    });
    const ev = (await listAlertEvents(pool, WS, 10))[0]!;
    expect(await acknowledgeAlert(pool, ev.id, WS)).toBe(true);
    expect(await acknowledgeAlert(pool, ev.id, WS)).toBe(false);
  });
});

describe('re-fire + by-id lookup', () => {
  test('a fired rule becomes due again once its cooldown elapses', async () => {
    const r = await rule(); // default 60m cooldown
    await withTx(pool, async (c) => {
      const due = await dueAlertRules(c);
      await fireAlert(c, { rule: due.find((x) => x.id === r.id)!, detail: {}, firedAt: new Date() });
    });
    await withTx(pool, async (c) => {
      expect((await dueAlertRules(c)).map((x) => x.id)).not.toContain(r.id); // within cooldown
    });
    await pool.query(`UPDATE alert_rules SET last_fired_at = now() - interval '2 hours' WHERE id=$1`, [r.id]);
    await withTx(pool, async (c) => {
      expect((await dueAlertRules(c)).map((x) => x.id)).toContain(r.id); // cooldown elapsed → due again
    });
  });

  test('getAlertEventById returns the firing by primary key', async () => {
    const r = await rule();
    await withTx(pool, async (c) => {
      await fireAlert(c, { rule: r, detail: { x: 1 }, firedAt: new Date() });
    });
    const ev = (await listAlertEvents(pool, WS, 1))[0]!;
    expect((await getAlertEventById(pool, ev.id))?.id).toBe(ev.id);
    expect(await getAlertEventById(pool, '00000000-0000-0000-0000-0000000000aa')).toBeNull();
  });
});
