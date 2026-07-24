# Alerts (Phase 2 Sub-project J) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-workspace alert rules that the scheduler evaluates over the `usage_events` ledger; on breach (past cooldown) record an append-only firing (in-app feed + incident banner) and optionally deliver a signed webhook.

**Architecture:** `alert_rules` + append-only `alert_events`. The scheduler's existing 5s sweep gains `runAlertSweep`, which selects due rules (`FOR UPDATE SKIP LOCKED`), evaluates `failure_rate`/`usage_threshold` over `usage_events`, and on breach inserts an event + sets `last_fired_at` (cooldown guard) + enqueues `alert.notify`. A worker consumer delivers the signed webhook with BullMQ retries (H's pattern).

**Tech Stack:** pnpm monorepo, TS ESM via tsx, Vitest (v8 coverage ≥80%), PostgreSQL (pg), Fastify, BullMQ, Next.js (Arus).

## Global Constraints

- Never hardcode secrets; never place secrets in logs/outputs/errors. No `console.log`.
- TDD: failing test first. Coverage ≥80% statements/branches/functions/lines per package.
- Immutability; focused files (<800 lines). Conventional commits `<type>: <description>`, NO attribution trailer.
- `Db = pg.Pool | pg.PoolClient`. In-tx repo calls receive the tx client.
- Append-only `alert_events` (insert + read/ack only). Webhook secret AES-GCM encrypted at rest, returned once.
- Migrations auto-apply by sorted filename; next is `0008_alerts.sql`.
- Rule types: `'failure_rate' | 'usage_threshold'`. Conditions evaluate over `usage_events` in `[now − windowMinutes, now)`.
- Reuse: `encryptSecret`/`decryptSecret` (@xperiment/db), `assertUrlAllowed` (@xperiment/connectors), `CALLBACK_JOB_OPTIONS` (@xperiment/queue) for the alert queue retry profile, `deps.triggerKey` (API) / `deriveTriggerKey(TRIGGER_SECRET_KEY)` (worker) for the HMAC secret.
- Branch `feature/phase2-alerts` is checked out; the spec is committed. Docker Postgres/Redis running.

---

### Task J-1: DB — alert_rules + alert_events migration and repo

**Files:**
- Create: `packages/db/src/migrations/0008_alerts.sql`
- Create: `packages/db/src/repos/alerts.ts`
- Modify: `packages/db/src/index.ts` (`export * from './repos/alerts.js';`)
- Test: `packages/db/test/alerts.test.ts`

**Interfaces:**
- Consumes: `Db` from `../pool.js`; `insertOutbox` from `./outbox.js`.
- Produces:
  - `type AlertType = 'failure_rate' | 'usage_threshold'`
  - `interface AlertRuleRow { id; workspaceId; name; type: AlertType; params: Record<string, unknown>; webhookUrl: string | null; enabled: boolean; cooldownMinutes: number; lastFiredAt: string | null; createdAt: string }`
  - `interface AlertEventRow { id; workspaceId; ruleId; firedAt: string; detail: Record<string, unknown>; acknowledgedAt: string | null; createdAt: string }`
  - `createAlertRule(db, args: { workspaceId; name; type; params; webhookUrl?: string; webhookSecretEncrypted?: Buffer; cooldownMinutes?: number }): Promise<AlertRuleRow>`
  - `listAlertRules(db, workspaceId): Promise<AlertRuleRow[]>`
  - `getAlertRule(db, id, workspaceId): Promise<AlertRuleRow | null>`
  - `updateAlertRule(db, id, workspaceId, patch: { name?; params?; enabled?; cooldownMinutes? }): Promise<AlertRuleRow | null>`
  - `deleteAlertRule(db, id, workspaceId): Promise<boolean>`
  - `dueAlertRules(client): Promise<AlertRuleRow[]>`
  - `evaluateFailureRate(db, args: { workspaceId; windowStart: Date }): Promise<{ total: number; failed: number }>`
  - `evaluateUsageMetric(db, args: { workspaceId; metric: string; windowStart: Date }): Promise<number>`
  - `fireAlert(client, args: { rule: AlertRuleRow; detail: Record<string, unknown>; firedAt: Date }): Promise<AlertEventRow>`
  - `listAlertEvents(db, workspaceId, limit: number): Promise<AlertEventRow[]>`
  - `countUnacknowledgedAlerts(db, workspaceId): Promise<number>`
  - `acknowledgeAlert(db, id, workspaceId): Promise<boolean>`
  - `getAlertWebhook(db, ruleId): Promise<{ url: string; secretEncrypted: Buffer } | null>`

- [ ] **Step 1: Write the migration**

Create `packages/db/src/migrations/0008_alerts.sql`:

```sql
CREATE TABLE alert_rules (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id),
  name                      TEXT NOT NULL,
  type                      TEXT NOT NULL,
  params                    JSONB NOT NULL,
  webhook_url               TEXT NULL,
  webhook_secret_encrypted  BYTEA NULL,
  enabled                   BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_minutes          INTEGER NOT NULL DEFAULT 60,
  last_fired_at             TIMESTAMPTZ NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_rules_workspace ON alert_rules (workspace_id, created_at DESC);
CREATE INDEX idx_alert_rules_enabled ON alert_rules (enabled) WHERE enabled;

CREATE TABLE alert_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id),
  rule_id          UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  fired_at         TIMESTAMPTZ NOT NULL,
  detail           JSONB NOT NULL,
  acknowledged_at  TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_events_workspace ON alert_events (workspace_id, fired_at DESC);
```

- [ ] **Step 2: Write the failing test**

Create `packages/db/test/alerts.test.ts`:

```ts
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  acknowledgeAlert, countUnacknowledgedAlerts, createAlertRule, createPool, deleteAlertRule,
  dueAlertRules, evaluateFailureRate, evaluateUsageMetric, fireAlert, getAlertRule, getAlertWebhook,
  insertUsageEvents, listAlertEvents, listAlertRules, runMigrations, updateAlertRule, withTx,
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
  createAlertRule(pool, { workspaceId: WS, name: 'r', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 1 } });

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
    expect(await evaluateUsageMetric(pool, { workspaceId: WS, metric: 'ai_tokens', windowStart: new Date(Date.now() - 3_600_000) })).toBe(150);
  });
});

describe('dueAlertRules + fireAlert', () => {
  test('a rule is due until fired, then not until cooldown elapses', async () => {
    const r = await rule();
    await withTx(pool, async (c) => {
      const due = await dueAlertRules(c);
      expect(due.map((x) => x.id)).toContain(r.id);
    });
    // Fire it, which sets last_fired_at = now.
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
      workspaceId: WS, name: 'w', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
      webhookUrl: 'https://example.com/a', webhookSecretEncrypted: Buffer.from([1, 2, 3]),
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @xperiment/db test -- alerts.test.ts`
Expected: FAIL — alert repo functions not exported.

- [ ] **Step 4: Implement the repo**

Create `packages/db/src/repos/alerts.ts`:

```ts
import { type Db } from '../pool.js';
import { insertOutbox } from './outbox.js';

export type AlertType = 'failure_rate' | 'usage_threshold';

export interface AlertRuleRow {
  id: string;
  workspaceId: string;
  name: string;
  type: AlertType;
  params: Record<string, unknown>;
  webhookUrl: string | null;
  enabled: boolean;
  cooldownMinutes: number;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface AlertEventRow {
  id: string;
  workspaceId: string;
  ruleId: string;
  firedAt: string;
  detail: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
}

const ts = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (v as string | null));

function mapRule(r: Record<string, unknown>): AlertRuleRow {
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    name: r['name'] as string,
    type: r['type'] as AlertType,
    params: (r['params'] as Record<string, unknown>) ?? {},
    webhookUrl: (r['webhook_url'] as string | null) ?? null,
    enabled: r['enabled'] as boolean,
    cooldownMinutes: Number(r['cooldown_minutes']),
    lastFiredAt: ts(r['last_fired_at']),
    createdAt: ts(r['created_at'])!,
  };
}

function mapEvent(r: Record<string, unknown>): AlertEventRow {
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    ruleId: r['rule_id'] as string,
    firedAt: ts(r['fired_at'])!,
    detail: (r['detail'] as Record<string, unknown>) ?? {},
    acknowledgedAt: ts(r['acknowledged_at']),
    createdAt: ts(r['created_at'])!,
  };
}

export async function createAlertRule(
  db: Db,
  args: { workspaceId: string; name: string; type: AlertType; params: Record<string, unknown>; webhookUrl?: string; webhookSecretEncrypted?: Buffer; cooldownMinutes?: number },
): Promise<AlertRuleRow> {
  const r = await db.query(
    `INSERT INTO alert_rules (workspace_id, name, type, params, webhook_url, webhook_secret_encrypted, cooldown_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,60)) RETURNING *`,
    [args.workspaceId, args.name, args.type, JSON.stringify(args.params), args.webhookUrl ?? null, args.webhookSecretEncrypted ?? null, args.cooldownMinutes ?? null],
  );
  return mapRule(r.rows[0] as Record<string, unknown>);
}

export async function listAlertRules(db: Db, workspaceId: string): Promise<AlertRuleRow[]> {
  const r = await db.query(`SELECT * FROM alert_rules WHERE workspace_id=$1 ORDER BY created_at DESC`, [workspaceId]);
  return (r.rows as Record<string, unknown>[]).map(mapRule);
}

export async function getAlertRule(db: Db, id: string, workspaceId: string): Promise<AlertRuleRow | null> {
  const r = await db.query(`SELECT * FROM alert_rules WHERE id=$1 AND workspace_id=$2`, [id, workspaceId]);
  return r.rowCount ? mapRule(r.rows[0] as Record<string, unknown>) : null;
}

export async function updateAlertRule(
  db: Db,
  id: string,
  workspaceId: string,
  patch: { name?: string; params?: Record<string, unknown>; enabled?: boolean; cooldownMinutes?: number },
): Promise<AlertRuleRow | null> {
  const r = await db.query(
    `UPDATE alert_rules SET
       name = COALESCE($3, name),
       params = COALESCE($4, params),
       enabled = COALESCE($5, enabled),
       cooldown_minutes = COALESCE($6, cooldown_minutes)
     WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [id, workspaceId, patch.name ?? null, patch.params ? JSON.stringify(patch.params) : null, patch.enabled ?? null, patch.cooldownMinutes ?? null],
  );
  return r.rowCount ? mapRule(r.rows[0] as Record<string, unknown>) : null;
}

export async function deleteAlertRule(db: Db, id: string, workspaceId: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM alert_rules WHERE id=$1 AND workspace_id=$2`, [id, workspaceId]);
  return (r.rowCount ?? 0) > 0;
}

export async function dueAlertRules(client: Db): Promise<AlertRuleRow[]> {
  const r = await client.query(
    `SELECT * FROM alert_rules
     WHERE enabled AND (last_fired_at IS NULL OR last_fired_at < now() - make_interval(mins => cooldown_minutes))
     FOR UPDATE SKIP LOCKED`,
  );
  return (r.rows as Record<string, unknown>[]).map(mapRule);
}

export async function evaluateFailureRate(db: Db, args: { workspaceId: string; windowStart: Date }): Promise<{ total: number; failed: number }> {
  const r = await db.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution'),0)::int AS total,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution' AND metadata->>'status'='FAILED'),0)::int AS failed
     FROM usage_events WHERE workspace_id=$1 AND occurred_at >= $2`,
    [args.workspaceId, args.windowStart.toISOString()],
  );
  const row = r.rows[0] as { total: number; failed: number };
  return { total: Number(row.total), failed: Number(row.failed) };
}

export async function evaluateUsageMetric(db: Db, args: { workspaceId: string; metric: string; windowStart: Date }): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(quantity),0)::bigint AS observed FROM usage_events
     WHERE workspace_id=$1 AND metric=$2 AND occurred_at >= $3`,
    [args.workspaceId, args.metric, args.windowStart.toISOString()],
  );
  return Number((r.rows[0] as { observed: string }).observed);
}

export async function fireAlert(
  client: Db,
  args: { rule: AlertRuleRow; detail: Record<string, unknown>; firedAt: Date },
): Promise<AlertEventRow> {
  const ev = await client.query(
    `INSERT INTO alert_events (workspace_id, rule_id, fired_at, detail) VALUES ($1,$2,$3,$4) RETURNING *`,
    [args.rule.workspaceId, args.rule.id, args.firedAt.toISOString(), JSON.stringify(args.detail)],
  );
  const event = mapEvent(ev.rows[0] as Record<string, unknown>);
  await client.query(`UPDATE alert_rules SET last_fired_at=$2 WHERE id=$1`, [args.rule.id, args.firedAt.toISOString()]);
  if (args.rule.webhookUrl) {
    await insertOutbox(client, { eventType: 'alert.notify', payload: { ruleId: args.rule.id, eventId: event.id } });
  }
  return event;
}

export async function listAlertEvents(db: Db, workspaceId: string, limit: number): Promise<AlertEventRow[]> {
  const r = await db.query(
    `SELECT * FROM alert_events WHERE workspace_id=$1 ORDER BY fired_at DESC LIMIT $2`,
    [workspaceId, Math.min(Math.max(limit, 1), 200)],
  );
  return (r.rows as Record<string, unknown>[]).map(mapEvent);
}

export async function countUnacknowledgedAlerts(db: Db, workspaceId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM alert_events WHERE workspace_id=$1 AND acknowledged_at IS NULL`,
    [workspaceId],
  );
  return Number((r.rows[0] as { c: number }).c);
}

export async function acknowledgeAlert(db: Db, id: string, workspaceId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE alert_events SET acknowledged_at=now() WHERE id=$1 AND workspace_id=$2 AND acknowledged_at IS NULL`,
    [id, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getAlertWebhook(db: Db, ruleId: string): Promise<{ url: string; secretEncrypted: Buffer } | null> {
  const r = await db.query(
    `SELECT webhook_url, webhook_secret_encrypted FROM alert_rules WHERE id=$1 AND webhook_url IS NOT NULL AND webhook_secret_encrypted IS NOT NULL`,
    [ruleId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { webhook_url: string; webhook_secret_encrypted: Buffer };
  return { url: row.webhook_url, secretEncrypted: row.webhook_secret_encrypted };
}
```

Add to `packages/db/src/index.ts`:

```ts
export * from './repos/alerts.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @xperiment/db test -- alerts.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify package + typecheck + commit**

```bash
pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck
git add packages/db/src/migrations/0008_alerts.sql packages/db/src/repos/alerts.ts packages/db/src/index.ts packages/db/test/alerts.test.ts
git commit -m "feat: add alert_rules + alert_events repo"
```

---

### Task J-2: Queue alert.notify + scheduler runAlertSweep

**Files:**
- Modify: `packages/queue/src/names.ts`, `packages/queue/src/publisher.ts`, `packages/queue/src/payloads.ts`
- Test: `packages/queue/test/publisher.test.ts` (extend)
- Create: `apps/scheduler/src/alertSweep.ts`
- Modify: `apps/scheduler/src/main.ts`
- Test: `apps/scheduler/test/alertSweep.test.ts`

**Interfaces:**
- Consumes: `dueAlertRules`, `evaluateFailureRate`, `evaluateUsageMetric`, `fireAlert`, `withTx` from `@xperiment/db`; `CALLBACK_JOB_OPTIONS` from `@xperiment/queue`.
- Produces: `runAlertSweep(deps: { pool: pg.Pool; log }): Promise<{ fired: number }>`; queue `alertNotify` with `jobIdFor('alert.notify', {eventId}) === 'alert_<eventId>'`.

- [ ] **Step 1: Wire the queue**

`packages/queue/src/names.ts`: add `alertNotify: 'alert.notify'` to `QUEUE_NAMES` (and its `QueueKey` union picks it up).

`packages/queue/src/publisher.ts`: add to the returned queues and `EVENT_TO_QUEUE`:

```ts
    executionCallback: make(QUEUE_NAMES.executionCallback, CALLBACK_JOB_OPTIONS),
    alertNotify: make(QUEUE_NAMES.alertNotify, CALLBACK_JOB_OPTIONS),
```
```ts
  'execution.callback': 'executionCallback',
  'alert.notify': 'alertNotify',
```

`packages/queue/src/payloads.ts`: add to `jobIdFor`:

```ts
    case 'alert.notify':
      return `alert_${payload['eventId']}`;
```

- [ ] **Step 2: Extend the queue test**

Add to `packages/queue/test/publisher.test.ts` a test that inserts an `alert.notify` outbox row and asserts the resulting `alert_<eventId>` job carries `attempts: 5` (same retry profile as callbacks):

```ts
test('alert.notify jobs carry BullMQ retries', async () => {
  await insertOutbox(pool, { eventType: 'alert.notify', payload: { ruleId: 'R', eventId: 'EV' } });
  const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50 });
  try {
    await new Promise((r) => setTimeout(r, 500));
    const job = await queues.alertNotify.getJob('alert_EV');
    expect(job).toBeDefined();
    expect(job!.opts.attempts).toBe(5);
  } finally {
    await publisher.stop();
  }
});
```

Also extend the `jobIdFor` test: `expect(jobIdFor('alert.notify', { eventId: 'EV' })).toBe('alert_EV');`.

Run: `pnpm --filter @xperiment/queue test` → after implementing Step 1, PASS.

- [ ] **Step 3: Write the failing scheduler test**

Create `apps/scheduler/test/alertSweep.test.ts`:

```ts
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

async function seedRuns(succeeded: number, failed: number) {
  const rows = [];
  for (let i = 0; i < succeeded; i += 1) rows.push({ workspaceId: WS, metric: 'execution' as const, quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: new Date() });
  for (let i = 0; i < failed; i += 1) rows.push({ workspaceId: WS, metric: 'execution' as const, quantity: 1, metadata: { status: 'FAILED' }, occurredAt: new Date() });
  await insertUsageEvents(pool, rows);
}

describe('runAlertSweep', () => {
  test('fires a failure_rate rule when the breach holds, once per cooldown', async () => {
    await createAlertRule(pool, { workspaceId: WS, name: 'fr', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 2 }, cooldownMinutes: 60 });
    await seedRuns(1, 3); // 3/4 = 0.75 >= 0.5, total 4 >= minSample 2
    const first = await runAlertSweep(deps());
    expect(first.fired).toBe(1);
    expect((await listAlertEvents(pool, WS, 10)).length).toBe(1);
    const second = await runAlertSweep(deps()); // within cooldown → no re-fire
    expect(second.fired).toBe(0);
    expect((await listAlertEvents(pool, WS, 10)).length).toBe(1);
  });

  test('does not fire below the min-sample guard', async () => {
    await createAlertRule(pool, { workspaceId: WS, name: 'fr', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 5 } });
    await seedRuns(0, 1); // 1/1 = 1.0 >= 0.5 BUT total 1 < minSample 5
    expect((await runAlertSweep(deps())).fired).toBe(0);
  });

  test('fires a usage_threshold rule when the metric sum crosses the threshold', async () => {
    await createAlertRule(pool, { workspaceId: WS, name: 'ut', type: 'usage_threshold', params: { windowMinutes: 60, metric: 'ai_tokens', threshold: 100 } });
    await insertUsageEvents(pool, [{ workspaceId: WS, metric: 'ai_tokens', quantity: 150, occurredAt: new Date() }]);
    expect((await runAlertSweep(deps())).fired).toBe(1);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @xperiment/scheduler test -- alertSweep.test.ts`
Expected: FAIL — `runAlertSweep` not found.

- [ ] **Step 5: Implement runAlertSweep**

Create `apps/scheduler/src/alertSweep.ts`:

```ts
import { dueAlertRules, evaluateFailureRate, evaluateUsageMetric, fireAlert, withTx, type AlertRuleRow } from '@xperiment/db';
import type pg from 'pg';

export interface AlertSweepDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** Evaluate each due alert rule over usage_events; fire (once per cooldown) on breach. */
export async function runAlertSweep(deps: AlertSweepDeps): Promise<{ fired: number }> {
  let fired = 0;
  await withTx(deps.pool, async (client) => {
    const due = await dueAlertRules(client);
    for (const rule of due) {
      await client.query('SAVEPOINT alert_item');
      try {
        const detail = await evaluate(client, rule);
        if (detail) {
          await fireAlert(client, { rule, detail, firedAt: new Date() });
          fired += 1;
        }
        await client.query('RELEASE SAVEPOINT alert_item');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT alert_item');
        deps.log('alert_sweep.rule_failed', { ruleId: rule.id, err: (e as Error).message });
      }
    }
  });
  if (fired) deps.log('alert_sweep.done', { fired });
  return { fired };
}

async function evaluate(client: pg.PoolClient, rule: AlertRuleRow): Promise<Record<string, unknown> | null> {
  const windowMinutes = num(rule.params['windowMinutes'], 60);
  const windowStart = new Date(Date.now() - windowMinutes * 60_000);

  if (rule.type === 'failure_rate') {
    const threshold = num(rule.params['threshold'], 1);
    const minSample = num(rule.params['minSample'], 1);
    const { total, failed } = await evaluateFailureRate(client, { workspaceId: rule.workspaceId, windowStart });
    if (total < minSample) return null;
    const rate = failed / total;
    if (rate < threshold) return null;
    return { type: 'failure_rate', observed: rate, failed, total, threshold, windowMinutes };
  }

  // usage_threshold
  const metric = String(rule.params['metric'] ?? 'execution');
  const threshold = num(rule.params['threshold'], Infinity);
  const observed = await evaluateUsageMetric(client, { workspaceId: rule.workspaceId, metric, windowStart });
  if (observed < threshold) return null;
  return { type: 'usage_threshold', metric, observed, threshold, windowMinutes };
}
```

Wire into `apps/scheduler/src/main.ts`: import `runAlertSweep` and add it to the `Promise.all`:

```ts
import { runAlertSweep } from './alertSweep.js';
```
```ts
  void Promise.all([
    runSchedulerTick({ pool, log }),
    runWaitSweep({ pool, log }),
    runAlertSweep({ pool, log }),
  ])
```

- [ ] **Step 6: Run to verify it passes + typecheck + commit**

```bash
pnpm --filter @xperiment/queue test && pnpm --filter @xperiment/scheduler test && pnpm --filter @xperiment/queue typecheck && pnpm --filter @xperiment/scheduler typecheck
git add packages/queue/src apps/scheduler/src/alertSweep.ts apps/scheduler/src/main.ts packages/queue/test/publisher.test.ts apps/scheduler/test/alertSweep.test.ts
git commit -m "feat: add alert evaluation sweep + alert.notify queue"
```

---

### Task J-3: Worker — signed alert webhook delivery

**Files:**
- Create: `apps/worker/src/alertDelivery.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/test/alertDelivery.test.ts`

**Interfaces:**
- Consumes: `assertUrlAllowed` (@xperiment/connectors); `decryptSecret`, `getAlertWebhook`, `listAlertEvents` (@xperiment/db).
- Produces: `runAlertDelivery(deps: AlertDeliveryDeps, payload: { ruleId: string; eventId: string }): Promise<void>` where `AlertDeliveryDeps = { pool; alertKey: Buffer; allowPrivateIps: boolean; log }`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/alertDelivery.test.ts` (model on `callback.test.ts`):

```ts
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createAlertRule, createPool, deriveTriggerKey, encryptSecret, fireAlert, listAlertEvents, runMigrations, withTx } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runAlertDelivery, type AlertDeliveryDeps } from '../src/alertDelivery.js';

const WS = '00000000-0000-0000-0000-000000000001';
const alertKey = deriveTriggerKey('xperiment-dev-trigger-secret-change-me');
let pool: Pool;
let deps: AlertDeliveryDeps;
let server: Server;
let baseUrl: string;
let received: { sig: string | undefined; body: unknown }[] = [];
let respStatus = 200;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  deps = { pool, alertKey, allowPrivateIps: true, log: () => {} };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      received.push({ sig: req.headers['x-xperiment-signature'] as string | undefined, body: JSON.parse(raw) });
      res.statusCode = respStatus;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE alert_events, alert_rules CASCADE`);
  received = [];
  respStatus = 200;
});

async function seedFiring(url: string | null, secret: string | null): Promise<{ ruleId: string; eventId: string }> {
  const rule = await createAlertRule(pool, {
    workspaceId: WS, name: 'r', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
    ...(url ? { webhookUrl: url } : {}), ...(secret ? { webhookSecretEncrypted: encryptSecret(secret, alertKey) } : {}),
  });
  await withTx(pool, async (c) => {
    const full = { ...rule, webhookUrl: url };
    await fireAlert(c, { rule: full, detail: { type: 'failure_rate', observed: 0.9 }, firedAt: new Date() });
  });
  const ev = (await listAlertEvents(pool, WS, 1))[0]!;
  return { ruleId: rule.id, eventId: ev.id };
}

describe('runAlertDelivery', () => {
  test('POSTs a body signed with the rule secret', async () => {
    const secret = randomBytes(16).toString('hex');
    const ids = await seedFiring(`${baseUrl}/hook`, secret);
    await runAlertDelivery(deps, ids);
    expect(received).toHaveLength(1);
    const body = JSON.stringify(received[0]!.body);
    expect(received[0]!.sig).toBe('sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
    expect((received[0]!.body as { ruleId: string }).ruleId).toBe(ids.ruleId);
  });

  test('throws on a non-2xx so BullMQ retries', async () => {
    respStatus = 500;
    const ids = await seedFiring(`${baseUrl}/hook`, randomBytes(8).toString('hex'));
    await expect(runAlertDelivery(deps, ids)).rejects.toThrow(/500/);
  });

  test('SSRF-blocks a private URL when private IPs are disallowed', async () => {
    const ids = await seedFiring('http://127.0.0.1:9/hook', randomBytes(8).toString('hex'));
    await expect(runAlertDelivery({ ...deps, allowPrivateIps: false }, ids)).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(received).toHaveLength(0);
  });

  test('no-ops when the rule has no webhook', async () => {
    const ids = await seedFiring(null, null);
    await runAlertDelivery(deps, ids);
    expect(received).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/worker test -- alertDelivery.test.ts`
Expected: FAIL — `runAlertDelivery` not found.

- [ ] **Step 3: Implement the consumer**

Create `apps/worker/src/alertDelivery.ts`:

```ts
import { createHmac } from 'node:crypto';
import { assertUrlAllowed } from '@xperiment/connectors';
import { decryptSecret, getAlertRule, getAlertWebhook, listAlertEvents } from '@xperiment/db';
import type pg from 'pg';

export interface AlertDeliveryDeps {
  pool: pg.Pool;
  alertKey: Buffer;
  allowPrivateIps: boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const TIMEOUT_MS = 10000;

/**
 * Delivers an alert firing to the rule's webhook: SSRF-checks the URL, then POSTs
 * a signed body. Throws on a non-2xx / blocked request so BullMQ retries. The
 * secret is never logged or sent — only the HMAC over the body is.
 */
export async function runAlertDelivery(deps: AlertDeliveryDeps, payload: { ruleId: string; eventId: string }): Promise<void> {
  const cb = await getAlertWebhook(deps.pool, payload.ruleId);
  if (!cb) {
    deps.log('alert_delivery.no_webhook', { ruleId: payload.ruleId });
    return;
  }
  // Load the rule (any workspace) and the specific firing for the payload body.
  const ruleRow = await deps.pool.query(`SELECT workspace_id, name FROM alert_rules WHERE id=$1`, [payload.ruleId]);
  if (!ruleRow.rowCount) {
    deps.log('alert_delivery.unknown_rule', { ruleId: payload.ruleId });
    return;
  }
  const rule = ruleRow.rows[0] as { workspace_id: string; name: string };
  const events = await listAlertEvents(deps.pool, rule.workspace_id, 200);
  const event = events.find((e) => e.id === payload.eventId);
  if (!event) {
    deps.log('alert_delivery.unknown_event', { eventId: payload.eventId });
    return;
  }

  await assertUrlAllowed(cb.url, { allowPrivate: deps.allowPrivateIps });

  const body = JSON.stringify({
    ruleId: payload.ruleId,
    ruleName: rule.name,
    workspaceId: rule.workspace_id,
    firedAt: event.firedAt,
    detail: event.detail,
  });
  const secret = decryptSecret(cb.secretEncrypted, deps.alertKey);
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  const res = await fetch(cb.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xperiment-signature': signature },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`alert webhook returned ${res.status}`);
  deps.log('alert_delivery.delivered', { ruleId: payload.ruleId, status: res.status });
}
```

> Note: `getAlertRule` is imported for type-parity with other consumers but the rule row is fetched directly here to avoid a workspace argument; keep the direct query. (If lint flags the unused import, drop `getAlertRule` from the import.)

Wire into `apps/worker/src/main.ts`: after the callback worker, add:

```ts
import { runAlertDelivery, type AlertDeliveryDeps } from './alertDelivery.js';
```
```ts
const alertDeps: AlertDeliveryDeps = {
  pool,
  alertKey: deriveTriggerKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
  allowPrivateIps: process.env['HTTP_ALLOW_PRIVATE_IPS'] === 'true',
  log: deps.log,
};
const alertWorker = new Worker<{ ruleId: string; eventId: string }>(
  QUEUE_NAMES.alertNotify,
  async (job) => runAlertDelivery(alertDeps, job.data),
  { connection, concurrency: 4 },
);
alertWorker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'alert delivery job failed'));
```

Add `await alertWorker.close();` to `shutdown()`.

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

```bash
pnpm --filter @xperiment/worker test && pnpm --filter @xperiment/worker typecheck
git add apps/worker/src/alertDelivery.ts apps/worker/src/main.ts apps/worker/test/alertDelivery.test.ts
git commit -m "feat: add signed alert webhook delivery worker"
```

---

### Task J-4: API — /v1/alerts CRUD + events + ack

**Files:**
- Create: `apps/api/src/routes/alerts.ts`
- Modify: `apps/api/src/server.ts` (register), `apps/api/src/openapi.ts` (paths)
- Test: `apps/api/test/alerts.test.ts`

**Interfaces:**
- Consumes: `createAlertRule`, `listAlertRules`, `getAlertRule`, `updateAlertRule`, `deleteAlertRule`, `listAlertEvents`, `countUnacknowledgedAlerts`, `acknowledgeAlert`, `encryptSecret` (@xperiment/db); `authOf`, `roleGate`; `sendProblem`; `deps.triggerKey`.
- Produces: `registerAlertRoutes(app, deps)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/alerts.test.ts`:

```ts
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE alert_events, alert_rules CASCADE`);
});

const failureRule = { name: 'high failures', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 3 } };

describe('/v1/alerts', () => {
  test('create returns the rule; a webhook rule returns its secret once', async () => {
    const r = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: failureRule });
    expect(r.statusCode).toBe(201);
    expect(r.json<{ secret?: string }>().secret).toBeUndefined();

    const w = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: { ...failureRule, name: 'w', webhookUrl: 'https://example.com/a' } });
    expect(w.statusCode).toBe(201);
    expect(typeof w.json<{ secret: string }>().secret).toBe('string');

    const list = await auth.inject({ method: 'GET', url: '/v1/alerts' });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2);
    expect(list.body).not.toContain('secret'); // secrets never listed
  });

  test('rejects invalid params per type', async () => {
    const bad = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: { name: 'x', type: 'failure_rate', params: { windowMinutes: 60, threshold: 5 } } });
    expect(bad.statusCode).toBe(400); // threshold must be 0..1
    const badMetric = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: { name: 'x', type: 'usage_threshold', params: { windowMinutes: 60, metric: 'bogus', threshold: 1 } } });
    expect(badMetric.statusCode).toBe(400);
  });

  test('update + delete + cross-workspace 404', async () => {
    const created = (await auth.inject({ method: 'POST', url: '/v1/alerts', payload: failureRule })).json<{ id: string }>();
    const upd = await auth.inject({ method: 'PUT', url: `/v1/alerts/${created.id}`, payload: { enabled: false } });
    expect(upd.json<{ enabled: boolean }>().enabled).toBe(false);
    const other = await createAuthedUser(app);
    expect((await other.inject({ method: 'PUT', url: `/v1/alerts/${created.id}`, payload: { enabled: true } })).statusCode).toBe(404);
    expect((await auth.inject({ method: 'DELETE', url: `/v1/alerts/${created.id}` })).statusCode).toBe(204);
  });

  test('events list + ack', async () => {
    const rule = (await auth.inject({ method: 'POST', url: '/v1/alerts', payload: failureRule })).json<{ id: string }>();
    await pool.query(`INSERT INTO alert_events (workspace_id, rule_id, fired_at, detail) VALUES ($1,$2,now(),'{}')`, [auth.workspaceId, rule.id]);
    const ev = await auth.inject({ method: 'GET', url: '/v1/alerts/events' });
    expect(ev.json<{ unacknowledged: number; items: { id: string }[] }>().unacknowledged).toBe(1);
    const id = ev.json<{ items: { id: string }[] }>().items[0]!.id;
    expect((await auth.inject({ method: 'POST', url: `/v1/alerts/events/${id}/ack` })).statusCode).toBe(200);
    expect((await auth.inject({ method: 'GET', url: '/v1/alerts/events' })).json<{ unacknowledged: number }>().unacknowledged).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/api test -- alerts.test.ts`
Expected: FAIL — routes not registered (404).

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/alerts.ts`:

```ts
import { randomBytes } from 'node:crypto';
import {
  acknowledgeAlert, countUnacknowledgedAlerts, createAlertRule, deleteAlertRule, encryptSecret,
  getAlertRule, listAlertEvents, listAlertRules, updateAlertRule,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, roleGate } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const failureParams = z.object({
  windowMinutes: z.number().int().min(1).max(1440),
  threshold: z.number().min(0).max(1),
  minSample: z.number().int().min(1).max(100000).default(1),
});
const usageParams = z.object({
  windowMinutes: z.number().int().min(1).max(1440),
  metric: z.enum(['execution', 'node', 'compute_ms', 'ai_tokens']),
  threshold: z.number().min(0),
});
const createSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('failure_rate'), name: z.string().min(1).max(120), params: failureParams, webhookUrl: z.string().url().optional(), cooldownMinutes: z.number().int().min(1).max(10080).optional() }),
  z.object({ type: z.literal('usage_threshold'), name: z.string().min(1).max(120), params: usageParams, webhookUrl: z.string().url().optional(), cooldownMinutes: z.number().int().min(1).max(10080).optional() }),
]);
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  cooldownMinutes: z.number().int().min(1).max(10080).optional(),
  params: z.record(z.unknown()).optional(),
});

export function registerAlertRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/alerts', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid alert rule', parsed.error.message);
    const d = parsed.data;
    let secret: string | undefined;
    let webhookSecretEncrypted: Buffer | undefined;
    if (d.webhookUrl) {
      secret = randomBytes(24).toString('base64url');
      webhookSecretEncrypted = encryptSecret(secret, deps.triggerKey);
    }
    const rule = await createAlertRule(deps.pool, {
      workspaceId: ctx.workspaceId, name: d.name, type: d.type, params: d.params,
      ...(d.webhookUrl ? { webhookUrl: d.webhookUrl } : {}),
      ...(webhookSecretEncrypted ? { webhookSecretEncrypted } : {}),
      ...(d.cooldownMinutes ? { cooldownMinutes: d.cooldownMinutes } : {}),
    });
    return reply.status(201).send({ ...rule, ...(secret ? { secret } : {}) });
  });

  app.get('/v1/alerts', async (req) => ({ items: await listAlertRules(deps.pool, authOf(req).workspaceId) }));

  app.put('/v1/alerts/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid update', parsed.error.message);
    const updated = await updateAlertRule(deps.pool, id, ctx.workspaceId, parsed.data);
    if (!updated) return sendProblem(reply, 404, 'Alert rule not found');
    return updated;
  });

  app.delete('/v1/alerts/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const { id } = req.params as { id: string };
    if (!(await getAlertRule(deps.pool, id, ctx.workspaceId))) return sendProblem(reply, 404, 'Alert rule not found');
    await deleteAlertRule(deps.pool, id, ctx.workspaceId);
    return reply.status(204).send();
  });

  app.get('/v1/alerts/events', async (req) => {
    const ws = authOf(req).workspaceId;
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return {
      items: await listAlertEvents(deps.pool, ws, Number.isFinite(limit) ? limit : 50),
      unacknowledged: await countUnacknowledgedAlerts(deps.pool, ws),
    };
  });

  app.post('/v1/alerts/events/:id/ack', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const { id } = req.params as { id: string };
    const ok = await acknowledgeAlert(deps.pool, id, ctx.workspaceId);
    if (!ok) return sendProblem(reply, 404, 'Alert event not found or already acknowledged');
    return { acknowledged: true };
  });
}
```

Register in `apps/api/src/server.ts` (import `registerAlertRoutes`, call after `registerUsageRoutes`). Add to `OPENAPI_DOCUMENT.paths`:

```ts
    '/v1/alerts': { get: { summary: 'List alert rules', tags: ['alerts'] }, post: { summary: 'Create an alert rule (webhook secret returned once)', tags: ['alerts'] } },
    '/v1/alerts/{id}': { put: { summary: 'Update an alert rule', tags: ['alerts'] }, delete: { summary: 'Delete an alert rule', tags: ['alerts'] } },
    '/v1/alerts/events': { get: { summary: 'Recent alert firings + unacknowledged count', tags: ['alerts'] } },
    '/v1/alerts/events/{id}/ack': { post: { summary: 'Acknowledge an alert firing', tags: ['alerts'] } },
```

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

```bash
pnpm --filter @xperiment/api test -- alerts.test.ts && pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/alerts.ts apps/api/src/server.ts apps/api/src/openapi.ts apps/api/test/alerts.test.ts
git commit -m "feat: add /v1/alerts CRUD, events, and ack"
```

---

### Task J-5: Web Alerts page + incident banner, e2e, docs, verification, review, merge

**Files:**
- Modify: `apps/web/src/lib/api.ts` (client methods + types)
- Create: `apps/web/src/app/(app)/alerts/page.tsx`
- Create: `apps/web/src/components/shell/IncidentBanner.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx` (mount the banner), `apps/web/src/components/shell/Sidebar.tsx` (nav)
- Test: `apps/web/test/api.test.ts` (matrix)
- Modify: `e2e/test/acceptance.test.ts`; `README.md`

**Interfaces:**
- Consumes: `GET/POST/PUT/DELETE /v1/alerts`, `GET /v1/alerts/events`, `POST /v1/alerts/events/:id/ack`.

- [ ] **Step 1: Add client methods + types (test first)**

In `apps/web/test/api.test.ts`, add to the matrix (before building `seen`): `await client.listAlerts(); await client.createAlert({ name: 'r', type: 'failure_rate', params: {} }); await client.listAlertEvents(); await client.acknowledgeAlert('a1');` and add the expected entries to `seen`:

```ts
      'GET /v1/alerts',
      'POST /v1/alerts',
      'GET /v1/alerts/events',
      'POST /v1/alerts/events/a1/ack',
```

Run: `pnpm --filter @xperiment/web test -- api.test.ts` → FAIL. Then implement in `apps/web/src/lib/api.ts`:

```ts
export interface AlertRule {
  id: string; name: string; type: string; params: Record<string, unknown>;
  webhookUrl: string | null; enabled: boolean; cooldownMinutes: number; lastFiredAt: string | null; createdAt: string;
}
export interface AlertEvent {
  id: string; ruleId: string; firedAt: string; detail: Record<string, unknown>; acknowledgedAt: string | null;
}
```
```ts
  listAlerts(): Promise<{ items: AlertRule[] }> {
    return this.request('GET', '/v1/alerts');
  }
  createAlert(body: { name: string; type: string; params: Record<string, unknown>; webhookUrl?: string; cooldownMinutes?: number }): Promise<AlertRule & { secret?: string }> {
    return this.request('POST', '/v1/alerts', { body });
  }
  updateAlert(id: string, body: { name?: string; enabled?: boolean; cooldownMinutes?: number; params?: Record<string, unknown> }): Promise<AlertRule> {
    return this.request('PUT', `/v1/alerts/${id}`, { body });
  }
  deleteAlert(id: string): Promise<void> {
    return this.request('DELETE', `/v1/alerts/${id}`);
  }
  listAlertEvents(): Promise<{ items: AlertEvent[]; unacknowledged: number }> {
    return this.request('GET', '/v1/alerts/events');
  }
  acknowledgeAlert(id: string): Promise<{ acknowledged: boolean }> {
    return this.request('POST', `/v1/alerts/events/${id}/ack`);
  }
```

Run: `pnpm --filter @xperiment/web test -- api.test.ts` → PASS.

- [ ] **Step 2: Build the Alerts page**

Create `apps/web/src/app/(app)/alerts/page.tsx` (`'use client'`): a container that `useQuery(['alert-rules'])` + `useQuery(['alert-events'])`. Render:
- A **create form**: name input, type select (`failure_rate`/`usage_threshold`); conditional params — failure_rate: windowMinutes, threshold (0..1), minSample; usage_threshold: windowMinutes, metric select, threshold; optional webhookUrl; on submit call `createAlert` and, if a `secret` is returned, show it once in a dismissible banner (`data-testid="alert-secret"`). Invalidate `['alert-rules']`.
- A **rules list**: name, type, enabled state (toggle via `updateAlert`), cooldown; delete button.
- A **firing feed**: recent `alert_events` (rule, firedAt, detail summary) with an "Acknowledge" button (`acknowledgeAlert` → invalidate `['alert-events']`).
Give the page root `data-testid="alerts-page"`. Use Arus tokens (surface-raised cards, status colors), consistent with the usage/approvals pages. Loading/empty/error states like those pages.

- [ ] **Step 3: Incident banner + nav**

Create `apps/web/src/components/shell/IncidentBanner.tsx` (`'use client'`): `useQuery(['alert-events'], () => getBrowserClient().listAlertEvents(), { refetchInterval: 15000 })`; when `data.unacknowledged > 0`, render a dismissible banner (`data-testid="incident-banner"`, `role="status"`) — e.g. `⚠ {n} unacknowledged alert(s)` — linking to `/alerts`, using `--status-failed`/`--color-coral` accents. Local `useState` dismissal that re-shows when the count increases.

Mount it in `apps/web/src/app/(app)/layout.tsx` at the top of `.q-content` (above `{children}`). Add `{ href: '/alerts', label: 'Alerts' }` to `NAV` in `Sidebar.tsx` (after Usage).

- [ ] **Step 4: Web build + typecheck**

Run: `pnpm --filter @xperiment/web build && pnpm --filter @xperiment/web typecheck`
Expected: build succeeds, types clean.

- [ ] **Step 5: E2E — alert fires and delivers a signed webhook**

In `e2e/test/acceptance.test.ts`, add a test: (a) create an alert-webhook receiver branch on the existing provider stub (record `{signature, body}` on `/xperiment-alert`); (b) run a workflow that FAILS so a `FAILED` execution usage row is written (reuse an existing failing scenario or build a minimal failing workflow); (c) `POST /v1/alerts` a `failure_rate` rule (`windowMinutes: 60, threshold: 0.01, minSample: 1`, `webhookUrl` = stub `/xperiment-alert`) and capture the returned `secret`; (d) invoke the sweep by calling the DB path directly is not available from e2e — instead wait for the scheduler tick (the e2e already runs the scheduler service) up to a timeout, polling `GET /v1/alerts/events` until `items.length >= 1`; (e) assert the firing exists and the stub received a webhook whose `x-xperiment-signature` equals `sha256=<hmac(secret, rawBody)>`.

> If waiting on the live scheduler is flaky in e2e, instead assert only the firing via `GET /v1/alerts/events` (scheduler-driven) and cover the exact signature in the worker unit test (Task J-3). Keep the e2e deterministic: poll with a bounded timeout and a clear failure message.

- [ ] **Step 6: README + docs**

Add a "## Alerts (Phase 2J)" section to `README.md`: `alert_rules` (failure_rate / usage_threshold over a window), scheduler evaluation with cooldown, in-app feed + incident banner, optional HMAC-signed SSRF-guarded webhook; `POST /v1/alerts` returns the signing secret once; `GET /v1/alerts/events` + ack.

- [ ] **Step 7: Full workspace verification**

```bash
pnpm run test:cov      # all packages ≥80% thresholds
pnpm typecheck
pnpm --filter @xperiment/e2e test
pnpm --filter @xperiment/web e2e
```

Expected: all green; add targeted tests if any new file dips a package under 80%.

- [ ] **Step 8: Commit**

```bash
git add apps/web e2e/test/acceptance.test.ts README.md
git commit -m "feat: add web Alerts page, incident banner, e2e, and docs"
```

- [ ] **Step 9: Adversarial review + merge**

Run the adversarial multi-dimension review (security: webhook SSRF + secret handling + tenant scoping on all /v1/alerts routes + no secret in list/logs; correctness: cooldown/last_fired_at single-fire under concurrent sweeps, failure_rate divide-by-zero/min-sample, window math, savepoint isolation, exactly-one outbox per firing; typescript: params jsonb typing, discriminated-union validation, bigint narrowing; test-gaps: cooldown-elapsed re-fire, usage_threshold boundary, delivery unknown-rule/event branches, ack idempotency). Triage confirmed findings, fix CRITICAL/HIGH, re-verify. Then:

```bash
git checkout master && git merge --ff-only feature/phase2-alerts && git branch -d feature/phase2-alerts
```

---

## Self-Review

**Spec coverage:** MON-005 failure-rate + quota → `failure_rate`/`usage_threshold` rules (J-1 repo, J-2 sweep). MON-010 incident banner → J-5 IncidentBanner. Delivery → J-3 signed webhook. Rule management → J-4 API + J-5 web. Latency/credential-expiry explicitly deferred in the spec.

**Placeholder scan:** No TBD/TODO; every code step shows real code. The e2e step gives a concrete polling strategy with a documented fallback (assert firing via API + signature in the worker unit test) rather than an open placeholder.

**Type consistency:** `AlertRuleRow`/`AlertEventRow`/`AlertType` defined in J-1 and consumed unchanged by J-2/J-3/J-4. `runAlertSweep`/`runAlertDelivery`/`fireAlert`/`dueAlertRules`/`getAlertWebhook` signatures match across tasks. Web `AlertRule`/`AlertEvent` mirror the API JSON shape (camelCase). Queue `alert.notify` / `jobIdFor('alert.notify',{eventId})` consistent between J-2 producer and J-3 consumer.
