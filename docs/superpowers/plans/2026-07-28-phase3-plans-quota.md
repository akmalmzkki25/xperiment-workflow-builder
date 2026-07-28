# Plans, Entitlements & Quota Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every workspace a plan, derive four limits from it, and refuse work that would exceed them — warning before blocking, with opt-in metered overage.

**Architecture:** A pure `@xperiment/plans` package holds the catalog and all policy arithmetic with zero I/O, so the API, gateway and scheduler can each enforce without importing from one another. Flow limits (executions, AI tokens) are counted by an UPSERT-incremented counter row written in the same transaction as the thing it counts; stock limits (active workflows, members) are live `count(*)`. `createExecutionWithTrigger` gains a `quota_exceeded` outcome in its return union, which makes every call site handle the refusal or fail to compile.

**Tech Stack:** pnpm workspaces, TypeScript strict + `noUncheckedIndexedAccess`, tsx (runs TS source, no build), Vitest + v8 coverage, Fastify, Next.js 14 App Router, node-postgres, BullMQ.

## Global Constraints

- Coverage thresholds are 80% on lines, statements, functions **and** branches, per package. A dip fails the build.
- Never hardcode secrets; never log or return one. Quota problem details carry metric/used/limit/reset only.
- No `console.log` anywhere — services use `deps.log`, Fastify routes use `req.log` / `reply.log`.
- Conventional commits, `<type>: <description>`, **no attribution trailer**.
- Immutable updates; no mutation of inputs.
- `null` in a `PlanLimits` field means unlimited — never `0`, never `Infinity`.
- Fail closed: a workspace with no `workspace_plans` row is on `free`, never unlimited.
- Postgres and Redis run in Docker containers named `postgres` and `redis`. Run `docker start postgres redis` before any db or e2e task.

---

## File Structure

**Create**
- `packages/plans/package.json`, `tsconfig.json`, `vitest.config.ts` — new pure package
- `packages/plans/src/index.ts` — catalog, limit resolution, quota arithmetic, period boundaries
- `packages/plans/test/quota.test.ts` — boundary tests
- `packages/db/src/migrations/0010_plans.sql` — two tables, one column, backfill
- `packages/db/src/repos/entitlements.ts` — plan row + counters + gauges
- `packages/db/test/entitlements.test.ts`
- `apps/api/src/routes/plan.ts` — `GET`/`PUT /v1/plan`
- `apps/api/test/quota.test.ts` — enforcement + plan routes
- `apps/web/src/app/(app)/plan/page.tsx` — plan + meters + overage toggle
- `apps/web/src/components/shell/QuotaBanner.tsx`

**Modify**
- `packages/db/src/repos/executions.ts` — quota check + counter increment inside `createExecutionWithTrigger`; return union
- `packages/db/src/repos/usage.ts` — `recordAiUsage` increments the `ai_tokens` counter
- `packages/db/src/repos/auth.ts` — `createWorkspaceWithOwner` seeds the plan row + managed quota rule
- `packages/db/src/repos/alerts.ts` — `AlertRuleRow.managed`, `'quota'` type, delete guard
- `packages/db/src/index.ts` — export the new repo
- `apps/api/src/routes/executions.ts` — handle `quota_exceeded` at execute + retry
- `apps/api/src/routes/triggers.ts` — 402 at the active-workflow cap
- `apps/api/src/routes/workspaces.ts` — 402 at the member cap
- `apps/api/src/routes/ai.ts` — 402 at the AI-token cap
- `apps/api/src/routes/alerts.ts` — refuse deleting a managed rule
- `apps/api/src/server.ts`, `apps/api/src/openapi.ts` — register + document `/v1/plan`
- `apps/api/test/rbac.test.ts` — matrix rows for both billing permissions; `UNROUTED` becomes `[]`
- `apps/gateway/src/server.ts` — 429 on quota refusal
- `apps/scheduler/src/tick.ts` — skip + log on quota refusal
- `apps/scheduler/src/alertSweep.ts` — `quota` evaluator
- `apps/web/src/lib/api.ts`, `apps/web/src/components/shell/Sidebar.tsx`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/test/api.test.ts`
- `e2e/test/acceptance.test.ts`, `README.md`

---

### Task N-1: The `@xperiment/plans` pure package

**Files:**
- Create: `packages/plans/package.json`, `packages/plans/tsconfig.json`, `packages/plans/vitest.config.ts`, `packages/plans/src/index.ts`
- Test: `packages/plans/test/quota.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PlanCode`, `LimitKey`, `PlanLimits`, `QuotaStatus`, `QuotaLine`, `PLAN_CATALOG`, `SOFT_LIMIT_RATIO`, `LIMIT_KEYS`, `resolveLimits(code, overrides)`, `evaluateQuota(limits, used, allowOverage)`, `isBlocked(lines, metric)`, `periodStart(now)`, `periodEnd(start)`.

- [ ] **Step 1: Scaffold the package**

`packages/plans/package.json`:

```json
{
  "name": "@xperiment/plans",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:cov": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@vitest/coverage-v8": "^2.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`packages/plans/tsconfig.json` — copy `packages/ir/tsconfig.json` verbatim.

`packages/plans/vitest.config.ts` — copy `packages/ir/vitest.config.ts` verbatim (it already carries the 80% thresholds).

Then run `pnpm install` from the repo root so the workspace link exists.

- [ ] **Step 2: Write the failing tests**

Create `packages/plans/test/quota.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  evaluateQuota,
  isBlocked,
  periodEnd,
  periodStart,
  PLAN_CATALOG,
  resolveLimits,
  SOFT_LIMIT_RATIO,
  type PlanLimits,
} from '../src/index.js';

const zero = { executionsPerMonth: 0, aiTokensPerMonth: 0, activeWorkflows: 0, members: 0 };

describe('PLAN_CATALOG', () => {
  test('every tier defines all four limits', () => {
    for (const [code, limits] of Object.entries(PLAN_CATALOG)) {
      for (const key of ['executionsPerMonth', 'aiTokensPerMonth', 'activeWorkflows', 'members'] as const) {
        expect(limits[key] === null || limits[key]! > 0, `${code}.${key}`).toBe(true);
      }
    }
  });

  test('business is the unlimited tier', () => {
    expect(PLAN_CATALOG.business).toEqual({
      executionsPerMonth: null,
      aiTokensPerMonth: null,
      activeWorkflows: null,
      members: null,
    });
  });
});

describe('resolveLimits', () => {
  test('overrides replace catalog values, including making one unlimited', () => {
    const limits = resolveLimits('free', { executionsPerMonth: 99, activeWorkflows: null });
    expect(limits.executionsPerMonth).toBe(99);
    expect(limits.activeWorkflows).toBeNull();
    expect(limits.members).toBe(PLAN_CATALOG.free.members);
  });

  test('an unknown code falls back to free rather than to unlimited', () => {
    expect(resolveLimits('nope' as never, {})).toEqual(PLAN_CATALOG.free);
  });
});

describe('evaluateQuota', () => {
  const limits: PlanLimits = { executionsPerMonth: 100, aiTokensPerMonth: null, activeWorkflows: 3, members: 2 };
  const line = (used: Partial<typeof zero>, overage = false) =>
    evaluateQuota(limits, { ...zero, ...used }, overage);

  test('well under the limit is ok', () => {
    expect(line({ executionsPerMonth: 50 })[0]).toMatchObject({ metric: 'executionsPerMonth', used: 50, status: 'ok' });
  });

  test('exactly at the soft threshold warns', () => {
    const used = 100 * SOFT_LIMIT_RATIO;
    expect(line({ executionsPerMonth: used })[0]!.status).toBe('warn');
  });

  test('one below the soft threshold is still ok', () => {
    expect(line({ executionsPerMonth: 100 * SOFT_LIMIT_RATIO - 1 })[0]!.status).toBe('ok');
  });

  test('exactly at the limit blocks', () => {
    expect(line({ executionsPerMonth: 100 })[0]!.status).toBe('blocked');
  });

  test('over the limit blocks', () => {
    expect(line({ executionsPerMonth: 101 })[0]!.status).toBe('blocked');
  });

  test('overage turns blocked into warn but never ok', () => {
    expect(line({ executionsPerMonth: 500 }, true)[0]!.status).toBe('warn');
  });

  test('a null limit is always ok, however large the usage', () => {
    const l = line({ aiTokensPerMonth: 9_999_999 }).find((x) => x.metric === 'aiTokensPerMonth')!;
    expect(l).toMatchObject({ limit: null, status: 'ok' });
  });

  test('returns one line per limit key', () => {
    expect(line({}).map((l) => l.metric).sort()).toEqual(
      ['activeWorkflows', 'aiTokensPerMonth', 'executionsPerMonth', 'members'],
    );
  });
});

describe('isBlocked', () => {
  test('is true only for the named blocked metric', () => {
    const lines = evaluateQuota(
      { executionsPerMonth: 1, aiTokensPerMonth: 1, activeWorkflows: null, members: null },
      { ...zero, executionsPerMonth: 5 },
      false,
    );
    expect(isBlocked(lines, 'executionsPerMonth')).toBe(true);
    expect(isBlocked(lines, 'aiTokensPerMonth')).toBe(false);
    expect(isBlocked(lines, 'activeWorkflows')).toBe(false);
  });
});

describe('period boundaries', () => {
  test('periodStart is the first instant of the UTC month', () => {
    expect(periodStart(new Date('2026-07-28T13:45:00Z')).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('a UTC month boundary belongs to the new month', () => {
    expect(periodStart(new Date('2026-08-01T00:00:00Z')).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('periodEnd rolls the year over', () => {
    expect(periodEnd(new Date('2026-12-01T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/plans test`
Expected: FAIL — `Failed to resolve import "../src/index.js"`.

- [ ] **Step 4: Implement the package**

Create `packages/plans/src/index.ts`:

```ts
export type PlanCode = 'free' | 'builder' | 'team' | 'business';

export type LimitKey = 'executionsPerMonth' | 'aiTokensPerMonth' | 'activeWorkflows' | 'members';

export const LIMIT_KEYS: readonly LimitKey[] = [
  'executionsPerMonth',
  'aiTokensPerMonth',
  'activeWorkflows',
  'members',
];

/** `null` means unlimited — never 0, never Infinity. */
export type PlanLimits = Record<LimitKey, number | null>;

/**
 * The commercial ladder is a hypothesis (PRD §15: "Pricing final memerlukan customer
 * discovery"), so it lives here as one plain object a later slice can swap for rows
 * from a billing provider without touching a single enforcement site.
 */
export const PLAN_CATALOG: Record<PlanCode, PlanLimits> = {
  free: { executionsPerMonth: 500, aiTokensPerMonth: 50_000, activeWorkflows: 3, members: 2 },
  builder: { executionsPerMonth: 10_000, aiTokensPerMonth: 500_000, activeWorkflows: 20, members: 3 },
  team: { executionsPerMonth: 50_000, aiTokensPerMonth: 2_000_000, activeWorkflows: 100, members: 15 },
  business: { executionsPerMonth: null, aiTokensPerMonth: null, activeWorkflows: null, members: null },
};

export const PLAN_CODES = Object.keys(PLAN_CATALOG) as PlanCode[];

export const SOFT_LIMIT_RATIO = 0.8;

export type QuotaStatus = 'ok' | 'warn' | 'blocked';

export interface QuotaLine {
  metric: LimitKey;
  used: number;
  limit: number | null;
  status: QuotaStatus;
}

/** Catalog limits with per-workspace overrides applied. Unknown code → free (fail closed). */
export function resolveLimits(code: PlanCode, overrides: Partial<PlanLimits>): PlanLimits {
  const base = PLAN_CATALOG[code] ?? PLAN_CATALOG.free;
  const out = { ...base };
  for (const key of LIMIT_KEYS) {
    if (key in overrides) out[key] = overrides[key] ?? null;
  }
  return out;
}

export function evaluateQuota(
  limits: PlanLimits,
  used: Record<LimitKey, number>,
  allowOverage: boolean,
): QuotaLine[] {
  return LIMIT_KEYS.map((metric) => {
    const limit = limits[metric];
    const consumed = used[metric];
    let status: QuotaStatus = 'ok';
    if (limit !== null) {
      if (consumed >= limit) status = allowOverage ? 'warn' : 'blocked';
      else if (consumed >= limit * SOFT_LIMIT_RATIO) status = 'warn';
    }
    return { metric, used: consumed, limit, status };
  });
}

export function isBlocked(lines: readonly QuotaLine[], metric: LimitKey): boolean {
  return lines.some((l) => l.metric === metric && l.status === 'blocked');
}

/** First instant of the UTC calendar month — the single definition of a billing period. */
export function periodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function periodEnd(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/plans test:cov`
Expected: PASS, all 15 tests, coverage 100%.

- [ ] **Step 6: Commit**

```bash
git add packages/plans pnpm-lock.yaml
git commit -m "feat: add the plans catalog and quota arithmetic"
```

---

### Task N-2: Migration 0010 and the entitlements repo

**Files:**
- Create: `packages/db/src/migrations/0010_plans.sql`, `packages/db/src/repos/entitlements.ts`
- Modify: `packages/db/package.json` (add `@xperiment/plans`), `packages/db/src/index.ts`, `packages/db/src/repos/auth.ts:72-87`, `packages/db/src/repos/alerts.ts`
- Test: `packages/db/test/entitlements.test.ts`

**Interfaces:**
- Consumes: `PlanCode`, `PlanLimits`, `LimitKey`, `periodStart` from `@xperiment/plans` (Task N-1).
- Produces: `WorkspacePlanRow`, `getWorkspacePlan`, `setWorkspacePlan`, `getQuotaUsage`, `incrementUsageCounter`, `recomputeCounters`, `CounterMetric`. `AlertRuleRow` gains `managed: boolean`; `AlertType` gains `'quota'`.

- [ ] **Step 1: Write the migration**

Create `packages/db/src/migrations/0010_plans.sql`:

```sql
CREATE TABLE workspace_plans (
  workspace_id    UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_code       TEXT NOT NULL DEFAULT 'free',
  limit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  allow_overage   BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_plans_code_check CHECK (plan_code IN ('free','builder','team','business'))
);

CREATE TABLE workspace_usage_counters (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  metric       TEXT NOT NULL,
  quantity     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period_start, metric),
  CONSTRAINT workspace_usage_counters_metric_check CHECK (metric IN ('execution','ai_tokens'))
);

ALTER TABLE alert_rules ADD COLUMN managed BOOLEAN NOT NULL DEFAULT false;

-- Existing workspaces land on free rather than unlimited.
INSERT INTO workspace_plans (workspace_id) SELECT id FROM workspaces
  ON CONFLICT (workspace_id) DO NOTHING;

-- One managed quota rule per workspace, so the soft limit rides Phase 2J's
-- cooldown, ack, and signed-webhook delivery instead of duplicating them.
INSERT INTO alert_rules (workspace_id, name, type, params, managed, cooldown_minutes)
SELECT w.id, 'Plan quota', 'quota', '{}'::jsonb, true, 720
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM alert_rules r WHERE r.workspace_id = w.id AND r.managed);
```

Note: `alert_rules.type` is bare `TEXT` with no CHECK constraint (verified in `0008_alerts.sql`), so `'quota'` needs no constraint change.

- [ ] **Step 2: Write the failing tests**

Create `packages/db/test/entitlements.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { periodStart } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createUser,
  createWorkspaceWithOwner,
  getQuotaUsage,
  getWorkspacePlan,
  incrementUsageCounter,
  insertUsageEvents,
  listAlertRules,
  recomputeCounters,
  setWorkspacePlan,
} from '../src/index.js';
import { createPool, runMigrations } from '../src/index.js';

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker start postgres redis && pnpm --filter @xperiment/db test -- entitlements.test.ts`
Expected: FAIL — `getWorkspacePlan is not exported`.

- [ ] **Step 4: Add the dependency and implement the repo**

Add to `packages/db/package.json` dependencies: `"@xperiment/plans": "workspace:*"`, then run `pnpm install` from the repo root.

Create `packages/db/src/repos/entitlements.ts`:

```ts
import { LIMIT_KEYS, PLAN_CATALOG, type LimitKey, type PlanCode, type PlanLimits } from '@xperiment/plans';
import { type Db } from '../pool.js';

/** Only flows are counted; stocks are live count(*). */
export type CounterMetric = 'execution' | 'ai_tokens';

const COUNTER_TO_LIMIT: Record<CounterMetric, LimitKey> = {
  execution: 'executionsPerMonth',
  ai_tokens: 'aiTokensPerMonth',
};

export interface WorkspacePlanRow {
  workspaceId: string;
  planCode: PlanCode;
  limitOverrides: Partial<PlanLimits>;
  allowOverage: boolean;
}

const FREE_DEFAULT = (workspaceId: string): WorkspacePlanRow => ({
  workspaceId,
  planCode: 'free',
  limitOverrides: {},
  allowOverage: false,
});

/**
 * A workspace with no row is on `free`, not unlimited — spend fails closed the same
 * way authorization does.
 */
export async function getWorkspacePlan(db: Db, workspaceId: string): Promise<WorkspacePlanRow> {
  const r = await db.query(
    `SELECT workspace_id, plan_code, limit_overrides, allow_overage FROM workspace_plans WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (!r.rowCount) return FREE_DEFAULT(workspaceId);
  const row = r.rows[0] as Record<string, unknown>;
  const code = row['plan_code'] as string;
  return {
    workspaceId,
    planCode: (code in PLAN_CATALOG ? code : 'free') as PlanCode,
    limitOverrides: (row['limit_overrides'] ?? {}) as Partial<PlanLimits>,
    allowOverage: row['allow_overage'] === true,
  };
}

export async function setWorkspacePlan(
  db: Db,
  args: { workspaceId: string; planCode?: PlanCode; allowOverage?: boolean },
): Promise<WorkspacePlanRow> {
  await db.query(
    `INSERT INTO workspace_plans (workspace_id, plan_code, allow_overage)
     VALUES ($1, COALESCE($2,'free'), COALESCE($3,false))
     ON CONFLICT (workspace_id) DO UPDATE
       SET plan_code = COALESCE($2, workspace_plans.plan_code),
           allow_overage = COALESCE($3, workspace_plans.allow_overage),
           updated_at = now()`,
    [args.workspaceId, args.planCode ?? null, args.allowOverage ?? null],
  );
  return getWorkspacePlan(db, args.workspaceId);
}

export async function incrementUsageCounter(
  db: Db,
  args: { workspaceId: string; periodStart: Date; metric: CounterMetric; quantity: number },
): Promise<void> {
  if (args.quantity <= 0) return;
  await db.query(
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, period_start, metric)
       DO UPDATE SET quantity = workspace_usage_counters.quantity + EXCLUDED.quantity`,
    [args.workspaceId, args.periodStart, args.metric, args.quantity],
  );
}

/** All four numbers: flows from counter rows, stocks from live count(*). */
export async function getQuotaUsage(
  db: Db,
  workspaceId: string,
  periodStart: Date,
): Promise<Record<LimitKey, number>> {
  const counters = await db.query(
    `SELECT metric, quantity FROM workspace_usage_counters WHERE workspace_id = $1 AND period_start = $2`,
    [workspaceId, periodStart],
  );
  const gauges = await db.query(
    `SELECT
       (SELECT count(*) FROM workflows WHERE workspace_id = $1 AND active)::int AS active_workflows,
       (SELECT count(*) FROM workspace_members WHERE workspace_id = $1)::int AS members`,
    [workspaceId],
  );
  const used = Object.fromEntries(LIMIT_KEYS.map((k) => [k, 0])) as Record<LimitKey, number>;
  for (const row of counters.rows as { metric: CounterMetric; quantity: string }[]) {
    const key = COUNTER_TO_LIMIT[row.metric];
    if (key) used[key] = Number(row.quantity);
  }
  const g = gauges.rows[0] as { active_workflows: number; members: number };
  used.activeWorkflows = g.active_workflows;
  used.members = g.members;
  return used;
}

/**
 * Rebuild the flow counters from the ledger, which stays the billing source of truth.
 * Drift is therefore detectable and repairable rather than silent.
 */
export async function recomputeCounters(db: Db, workspaceId: string, periodStart: Date): Promise<void> {
  await db.query(
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     SELECT $1, $2, metric, COALESCE(SUM(quantity),0)
     FROM usage_events
     WHERE workspace_id = $1 AND metric IN ('execution','ai_tokens')
       AND occurred_at >= $2 AND occurred_at < ($2::date + INTERVAL '1 month')
     GROUP BY metric
     ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [workspaceId, periodStart],
  );
}
```

- [ ] **Step 5: Seed the plan row and managed rule at workspace creation**

In `packages/db/src/repos/auth.ts`, inside `createWorkspaceWithOwner`'s `withTx` callback, after the `workspace_members` insert and before `return row`:

```ts
    // A workspace is born with a plan and a managed quota alert rule, so enforcement
    // and warning are never retro-fitted onto a workspace that predates them.
    await client.query(`INSERT INTO workspace_plans (workspace_id) VALUES ($1)`, [row.id]);
    await client.query(
      `INSERT INTO alert_rules (workspace_id, name, type, params, managed, cooldown_minutes)
       VALUES ($1, 'Plan quota', 'quota', '{}'::jsonb, true, 720)`,
      [row.id],
    );
```

- [ ] **Step 6: Widen the alert types**

In `packages/db/src/repos/alerts.ts`, change the `AlertType` union to include `'quota'`, add `managed: boolean` to `AlertRuleRow`, map it in `mapRule` as `managed: r['managed'] === true`, and add `managed` to every `SELECT` column list in that file.

- [ ] **Step 7: Export the repo**

In `packages/db/src/index.ts`, add after the usage export:

```ts
export * from './repos/entitlements.js';
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/db test -- entitlements.test.ts`
Expected: PASS, 8 tests.

Then `pnpm --filter @xperiment/db test` — the whole db suite must stay green, since `createWorkspaceWithOwner` changed.

- [ ] **Step 9: Commit**

```bash
git add packages/db packages/plans pnpm-lock.yaml
git commit -m "feat: add workspace plans, usage counters, and the managed quota rule"
```

---

### Task N-3: Enforce the execution cap at the creation chokepoint

This is the task that closes the burst hole. The check, the increment, and the execution
insert all live in one transaction, contending on one counter row.

**Files:**
- Modify: `packages/db/src/repos/executions.ts:51-110`, `packages/db/src/repos/usage.ts` (`recordAiUsage`), `apps/api/src/routes/executions.ts:49,155`, `apps/gateway/src/server.ts:79`, `apps/scheduler/src/tick.ts:47`
- Test: `packages/db/test/quotaEnforcement.test.ts`

**Interfaces:**
- Consumes: `getWorkspacePlan`, `getQuotaUsage`, `incrementUsageCounter` (N-2); `resolveLimits`, `evaluateQuota`, `isBlocked`, `periodStart` (N-1).
- Produces: `CreateExecutionResult` — a discriminated union on `outcome`:
  `{ outcome: 'created' | 'duplicate'; execution: ExecutionRow }` or
  `{ outcome: 'quota_exceeded'; metric: LimitKey; used: number; limit: number }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/test/quotaEnforcement.test.ts`:

```ts
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
import { canonicalHash } from '@xperiment/ir';

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

/** A workspace holding one published workflow, with `executionsPerMonth` forced to `cap`. */
async function seeded(cap: number): Promise<{ workflowId: string; versionId: string; workspaceId: string }> {
  const user = await createUser(pool, { email: `q-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Q', userId: user!.id });
  const wf = await createWorkflow(pool, { workspaceId: ws.id, name: 'Q' });
  await updateDraft(pool, { workflowId: wf.id, definition: IR, expectedRevision: 1 });
  const version = await createVersion(pool, {
    workflowId: wf.id,
    definition: IR,
    hash: canonicalHash(IR as never),
  });
  await pool.query(
    `UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`,
    [ws.id, JSON.stringify({ executionsPerMonth: cap })],
  );
  return { workflowId: wf.id, versionId: version.id, workspaceId: ws.id };
}

const create = (s: { workflowId: string; versionId: string }, key: string) =>
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/db test -- quotaEnforcement.test.ts`
Expected: FAIL — `Property 'outcome' does not exist` / every assertion on `outcome` is undefined.

- [ ] **Step 3: Implement the check inside `createExecutionWithTrigger`**

In `packages/db/src/repos/executions.ts`, add imports at the top:

```ts
import { evaluateQuota, isBlocked, periodStart, resolveLimits, type LimitKey } from '@xperiment/plans';
import { getQuotaUsage, getWorkspacePlan } from './entitlements.js';
```

Replace the signature and the body between the duplicate check and the execution insert:

```ts
export type CreateExecutionResult =
  | { outcome: 'created' | 'duplicate'; execution: ExecutionRow }
  | { outcome: 'quota_exceeded'; metric: LimitKey; used: number; limit: number };

export async function createExecutionWithTrigger(
  pool: pg.Pool,
  args: {
    workflowId: string;
    versionId: string;
    idempotencyKey: string;
    payload: unknown;
    nodeIds: string[];
    executionTimeoutMs: number;
  },
): Promise<CreateExecutionResult> {
  return withTx(pool, async (client) => {
    // workspace_id is inherited from the workflow row — tenancy by construction.
    const te = await client.query(
      `INSERT INTO trigger_events (workspace_id, workflow_id, idempotency_key, payload_json)
       SELECT w.workspace_id, w.id, $2, $3 FROM workflows w WHERE w.id = $1
       ON CONFLICT (workflow_id, idempotency_key) DO NOTHING RETURNING id, workspace_id`,
      [args.workflowId, args.idempotencyKey, capJson(args.payload)],
    );
    if (!te.rowCount) {
      const existing = await client.query(
        `SELECT e.* FROM executions e
         JOIN trigger_events t ON t.id = e.trigger_event_id
         WHERE t.workflow_id = $1 AND t.idempotency_key = $2`,
        [args.workflowId, args.idempotencyKey],
      );
      // A replay is free: it consumes no quota because it starts no new work.
      return { outcome: 'duplicate', execution: mapExecution(existing.rows[0] as Record<string, unknown>) };
    }
    const { id: triggerEventId, workspace_id: workspaceId } = te.rows[0] as { id: string; workspace_id: string };

    const period = periodStart(new Date());
    const refusal = await checkAndConsumeExecutionQuota(client, workspaceId, period);
    if (refusal) return refusal;

    const ex = await client.query(
      // ... unchanged execution insert, nodes loop, outbox inserts ...
```

and change the final `return { execution, created: true }` to `return { outcome: 'created', execution }`.

Add the helper below `createExecutionWithTrigger`:

```ts
/**
 * Reserve one execution against the workspace's monthly cap.
 *
 * `FOR UPDATE` alone would lock nothing on the first request of a period, because the
 * row does not exist yet — precisely when a burst is most likely. So the row is
 * materialised first, then locked, then compared, then incremented. Every concurrent
 * creation for this workspace and period contends on that one row, which makes the
 * check and the increment atomic with respect to each other and to the execution insert.
 */
async function checkAndConsumeExecutionQuota(
  client: pg.PoolClient,
  workspaceId: string,
  period: Date,
): Promise<{ outcome: 'quota_exceeded'; metric: LimitKey; used: number; limit: number } | null> {
  const plan = await getWorkspacePlan(client, workspaceId);
  const limits = resolveLimits(plan.planCode, plan.limitOverrides);
  const limit = limits.executionsPerMonth;
  if (limit === null) return null; // unlimited: no row to touch, no lock to take

  await client.query(
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     VALUES ($1,$2,'execution',0) ON CONFLICT DO NOTHING`,
    [workspaceId, period],
  );
  const locked = await client.query(
    `SELECT quantity FROM workspace_usage_counters
     WHERE workspace_id=$1 AND period_start=$2 AND metric='execution' FOR UPDATE`,
    [workspaceId, period],
  );
  const used = Number((locked.rows[0] as { quantity: string }).quantity);

  const usage = await getQuotaUsage(client, workspaceId, period);
  const lines = evaluateQuota(limits, { ...usage, executionsPerMonth: used }, plan.allowOverage);
  if (isBlocked(lines, 'executionsPerMonth')) {
    return { outcome: 'quota_exceeded', metric: 'executionsPerMonth', used, limit };
  }

  await client.query(
    `UPDATE workspace_usage_counters SET quantity = quantity + 1
     WHERE workspace_id=$1 AND period_start=$2 AND metric='execution'`,
    [workspaceId, period],
  );
  return null;
}
```

- [ ] **Step 4: Count AI tokens on the same counter**

In `packages/db/src/repos/usage.ts`, add `import { periodStart } from '@xperiment/plans';` and
`import { incrementUsageCounter } from './entitlements.js';`, then append to `recordAiUsage`
after `insertUsageEvents`:

```ts
  await incrementUsageCounter(db, {
    workspaceId: args.workspaceId,
    periodStart: periodStart(new Date()),
    metric: 'ai_tokens',
    quantity: args.tokens,
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/db test -- quotaEnforcement.test.ts`
Expected: PASS, 7 tests including the parallel one.

Then prove the parallel test earns its place: temporarily replace the three-statement
protocol with a plain non-locking `SELECT quantity …` (no `FOR UPDATE`), re-run, and
confirm the parallel test FAILS while the sequential ones still pass. Restore the
protocol and confirm green again.

- [ ] **Step 6: Update the four call sites**

`apps/api/src/routes/executions.ts` — both handlers. Replace each
`const { execution, created } = await createExecutionWithTrigger(...)` block's tail with:

```ts
    const result = await createExecutionWithTrigger(deps.pool, {
      /* ...unchanged args... */
    });
    if (result.outcome === 'quota_exceeded') {
      return sendProblem(
        reply,
        402,
        'Quota exceeded',
        `${result.metric}: ${result.used} of ${result.limit} used this period. Upgrade the plan or enable overage.`,
      );
    }
    const created = result.outcome === 'created';
    return reply
      .status(created ? 201 : 200)
      .send({ executionId: result.execution.id, status: result.execution.status, created });
```

`apps/gateway/src/server.ts` — after the call:

```ts
      if (result.outcome === 'quota_exceeded') {
        // Generic on purpose: an unauthenticated caller must not learn the
        // workspace's plan state from a webhook response.
        return reply.status(429).send({ title: 'Too Many Requests', status: 429 });
      }
      const created = result.outcome === 'created';
      if (created && mode === 'test') {
        await deps.pool.query(`UPDATE executions SET mode = 'test' WHERE id = $1`, [result.execution.id]);
      }
      return reply.status(created ? 202 : 200).send({ executionId: result.execution.id, created });
```

`apps/scheduler/src/tick.ts` — replace the bare `await createExecutionWithTrigger(...)`:

```ts
      const result = await createExecutionWithTrigger(deps.pool, {
        /* ...unchanged args... */
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
```

- [ ] **Step 7: Verify the whole workspace still compiles and passes**

Run: `pnpm typecheck` — expect exit 0. Any call site that still destructures
`{ execution, created }` will fail here; that is the union doing its job.

Run: `pnpm --filter @xperiment/db test && pnpm --filter @xperiment/api test && pnpm --filter @xperiment/gateway test && pnpm --filter @xperiment/scheduler test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/db apps/api apps/gateway apps/scheduler
git commit -m "feat: enforce the execution cap at the creation chokepoint"
```

---

### Task N-4: Stock limits, the plan routes, and the RBAC matrix

**Files:**
- Create: `apps/api/src/routes/plan.ts`
- Modify: `apps/api/src/routes/triggers.ts` (activate), `apps/api/src/routes/workspaces.ts` (invites), `apps/api/src/routes/ai.ts`, `apps/api/src/routes/alerts.ts` (managed delete guard), `apps/api/src/server.ts`, `apps/api/src/openapi.ts`, `apps/api/test/rbac.test.ts`
- Test: `apps/api/test/quota.test.ts`

**Interfaces:**
- Consumes: `getWorkspacePlan`, `setWorkspacePlan`, `getQuotaUsage` (N-2); `resolveLimits`, `evaluateQuota`, `isBlocked`, `periodStart`, `periodEnd`, `PLAN_CODES` (N-1); `requirePermission` (Phase 3M).
- Produces: `GET /v1/plan`, `PUT /v1/plan`, and a shared `quotaGate(pool, reply, workspaceId, metric)` helper exported from `apps/api/src/routes/plan.ts`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/quota.test.ts`:

```ts
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import { PLAN_CATALOG } from '@xperiment/plans';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const setLimit = (ws: string, patch: Record<string, number | null>) =>
  pool.query(`UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`, [ws, JSON.stringify(patch)]);

describe('GET /v1/plan', () => {
  test('reports the plan, limits, usage and one line per limit', async () => {
    const user = await createAuthedUser(app);
    const r = await user.inject({ method: 'GET', url: '/v1/plan' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ planCode: string; limits: Record<string, unknown>; lines: { metric: string }[] }>();
    expect(body.planCode).toBe('free');
    expect(body.limits).toEqual(PLAN_CATALOG.free);
    expect(body.lines).toHaveLength(4);
  });

  test('a viewer cannot read the plan', async () => {
    const owner = await createAuthedUser(app);
    const viewer = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    expect((await viewer.inject({ method: 'GET', url: '/v1/plan' })).statusCode).toBe(403);
  });

  test('a billing member can read and change the plan', async () => {
    const owner = await createAuthedUser(app);
    const billing = await addMemberWithRole(app, pool, owner.workspaceId, 'billing');
    expect((await billing.inject({ method: 'GET', url: '/v1/plan' })).statusCode).toBe(200);
    const put = await billing.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'team' } });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ planCode: string }>().planCode).toBe('team');
  });
});

describe('PUT /v1/plan', () => {
  test('rejects an unknown plan code', async () => {
    const user = await createAuthedUser(app);
    expect((await user.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'gold' } })).statusCode).toBe(400);
  });

  test('toggles overage', async () => {
    const user = await createAuthedUser(app);
    const r = await user.inject({ method: 'PUT', url: '/v1/plan', payload: { allowOverage: true } });
    expect(r.json<{ allowOverage: boolean }>().allowOverage).toBe(true);
  });

  test('refuses a downgrade the workspace already exceeds', async () => {
    const user = await createAuthedUser(app);
    // free allows 2 members; add a third so `team`→`free` would strand it.
    await addMemberWithRole(app, pool, user.workspaceId, 'viewer');
    await addMemberWithRole(app, pool, user.workspaceId, 'viewer');
    await user.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'team' } });
    const down = await user.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'free' } });
    expect(down.statusCode).toBe(409);
    expect(down.json<{ detail: string }>().detail).toContain('members');
  });
});

describe('stock limits', () => {
  test('activating past the active-workflow cap is refused with 402', async () => {
    const user = await createAuthedUser(app);
    await setLimit(user.workspaceId, { activeWorkflows: 0 });
    const wf = (await user.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'cap' } })).json<{
      id: string;
    }>();
    const r = await user.inject({ method: 'POST', url: `/v1/workflows/${wf.id}/activate` });
    expect(r.statusCode).toBe(402);
    expect(r.json<{ detail: string }>().detail).toContain('activeWorkflows');
  });

  test('inviting past the member cap is refused with 402', async () => {
    const user = await createAuthedUser(app);
    await setLimit(user.workspaceId, { members: 1 });
    const r = await user.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'viewer' } });
    expect(r.statusCode).toBe(402);
    expect(r.json<{ detail: string }>().detail).toContain('members');
  });

  test('an AI call past the token cap is refused with 402', async () => {
    const user = await createAuthedUser(app);
    await setLimit(user.workspaceId, { aiTokensPerMonth: 1 });
    await pool.query(
      `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 'ai_tokens', 10)
       ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = 10`,
      [user.workspaceId],
    );
    const r = await user.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: 'hi' } });
    expect(r.statusCode).toBe(402);
  });
});

describe('managed alert rules', () => {
  test('the managed quota rule cannot be deleted but can be disabled', async () => {
    const user = await createAuthedUser(app);
    const rules = (await user.inject({ method: 'GET', url: '/v1/alerts' })).json<{
      items: { id: string; managed: boolean }[];
    }>().items;
    const managed = rules.find((r) => r.managed)!;
    expect(managed).toBeTruthy();
    expect((await user.inject({ method: 'DELETE', url: `/v1/alerts/${managed.id}` })).statusCode).toBe(409);
    const off = await user.inject({ method: 'PUT', url: `/v1/alerts/${managed.id}`, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/api test -- quota.test.ts`
Expected: FAIL — `GET /v1/plan` returns 404.

- [ ] **Step 3: Implement the plan routes and the shared gate**

Create `apps/api/src/routes/plan.ts`:

```ts
import { getQuotaUsage, getWorkspacePlan, setWorkspacePlan } from '@xperiment/db';
import {
  evaluateQuota,
  isBlocked,
  periodEnd,
  periodStart,
  PLAN_CODES,
  resolveLimits,
  type LimitKey,
} from '@xperiment/plans';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const updateSchema = z
  .object({ planCode: z.enum(PLAN_CODES as [string, ...string[]]).optional(), allowOverage: z.boolean().optional() })
  .strict();

/** Current plan, limits, usage and per-limit status for one workspace. */
export async function quotaSnapshot(pool: pg.Pool, workspaceId: string) {
  const plan = await getWorkspacePlan(pool, workspaceId);
  const limits = resolveLimits(plan.planCode, plan.limitOverrides);
  const start = periodStart(new Date());
  const usage = await getQuotaUsage(pool, workspaceId, start);
  return {
    planCode: plan.planCode,
    allowOverage: plan.allowOverage,
    limits,
    usage,
    lines: evaluateQuota(limits, usage, plan.allowOverage),
    period: { start: start.toISOString(), end: periodEnd(start).toISOString() },
  };
}

/**
 * Refuse a stock-limited action with 402. Returns true when the caller should stop.
 * Flow limits are enforced in the DB chokepoint instead — this covers the actions that
 * grow a gauge (activating a workflow, adding a member, spending AI tokens).
 */
export async function quotaBlocks(
  pool: pg.Pool,
  reply: FastifyReply,
  workspaceId: string,
  metric: LimitKey,
): Promise<boolean> {
  const snap = await quotaSnapshot(pool, workspaceId);
  if (!isBlocked(snap.lines, metric)) return false;
  const line = snap.lines.find((l) => l.metric === metric)!;
  sendProblem(
    reply,
    402,
    'Quota exceeded',
    `${metric}: ${line.used} of ${line.limit} used. Upgrade the plan or enable overage.`,
  );
  return true;
}

export function registerPlanRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/plan', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:read')) return;
    return quotaSnapshot(deps.pool, ctx.workspaceId);
  });

  app.put('/v1/plan', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:manage')) return;
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid plan change', parsed.error.message);

    if (parsed.data.planCode) {
      // A downgrade must not strand a workspace above a stock limit it cannot shed
      // automatically — refuse rather than leave it permanently blocked.
      const start = periodStart(new Date());
      const usage = await getQuotaUsage(deps.pool, ctx.workspaceId, start);
      const next = resolveLimits(parsed.data.planCode, {});
      for (const metric of ['activeWorkflows', 'members'] as const) {
        const limit = next[metric];
        if (limit !== null && usage[metric] > limit) {
          return sendProblem(
            reply,
            409,
            'Plan too small',
            `${metric}: the workspace has ${usage[metric]}, and ${parsed.data.planCode} allows ${limit}.`,
          );
        }
      }
    }
    await setWorkspacePlan(deps.pool, {
      workspaceId: ctx.workspaceId,
      ...(parsed.data.planCode ? { planCode: parsed.data.planCode } : {}),
      ...(parsed.data.allowOverage !== undefined ? { allowOverage: parsed.data.allowOverage } : {}),
    });
    return quotaSnapshot(deps.pool, ctx.workspaceId);
  });
}
```

Note the `PLAN_CODES` cast: zod's `enum` needs a non-empty tuple type, and `PLAN_CODES`
is derived from the catalog so the two can never drift.

- [ ] **Step 4: Register the routes**

In `apps/api/src/server.ts`, import `registerPlanRoutes` and call it beside the other
`register*Routes` calls.

In `apps/api/src/openapi.ts`, add to `paths`:

```ts
    '/v1/plan': {
      get: { summary: 'Plan, limits, usage and per-limit status', tags: ['billing'] },
      put: { summary: 'Change the plan or toggle overage', tags: ['billing'] },
    },
```

- [ ] **Step 5: Gate the three stock actions**

`apps/api/src/routes/triggers.ts`, in `POST /v1/workflows/:id/activate` immediately after
the `workflow:activate` permission check:

```ts
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'activeWorkflows')) return;
```

`apps/api/src/routes/workspaces.ts`, in `POST /v1/workspaces/invites` after the
`member:manage` check:

```ts
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'members')) return;
```

`apps/api/src/routes/ai.ts`, in both `/v1/ai/generate` and `/v1/ai/edit` after their
`workflow:write` checks:

```ts
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'aiTokensPerMonth')) return;
```

Each file imports `{ quotaBlocks } from './plan.js'`.

- [ ] **Step 6: Guard the managed alert rule**

In `apps/api/src/routes/alerts.ts`, in `DELETE /v1/alerts/:id`, replace the existence
check with:

```ts
    const existing = await getAlertRule(deps.pool, id, ctx.workspaceId);
    if (!existing) return sendProblem(reply, 404, 'Alert rule not found');
    if (existing.managed) {
      return sendProblem(
        reply,
        409,
        'Managed rule',
        'The plan quota rule cannot be deleted. Disable it instead if you do not want the warnings.',
      );
    }
```

- [ ] **Step 7: Close the RBAC gap**

In `apps/api/test/rbac.test.ts`, add two `MATRIX` rows and empty the allowlist:

```ts
  { permission: 'billing:read', method: 'GET', url: '/v1/plan' },
  { permission: 'billing:manage', method: 'PUT', url: '/v1/plan', payload: { allowOverage: false } },
```

```ts
/** Every declared permission is now routed. */
const UNROUTED: Permission[] = [];
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/api test`
Expected: PASS — the full API suite, including `quota.test.ts` and the widened matrix.

- [ ] **Step 9: Commit**

```bash
git add apps/api
git commit -m "feat: add the plan routes and stock-limit enforcement"
```

---

### Task N-5: The quota evaluator in the alert sweep

**Files:**
- Modify: `apps/scheduler/src/alertSweep.ts`
- Test: `apps/scheduler/test/alertSweep.test.ts`

**Interfaces:**
- Consumes: `getWorkspacePlan`, `getQuotaUsage` (N-2); `evaluateQuota`, `resolveLimits`, `periodStart` (N-1); the existing `dueAlertRules` / `fireAlert` (Phase 2J).
- Produces: nothing new — `runAlertSweep`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `apps/scheduler/test/alertSweep.test.ts`:

```ts
  test('the managed quota rule fires when a limit reaches the soft threshold', async () => {
    const ws = await seedWorkspace(); // existing helper in this file
    await pool.query(`UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`, [
      ws,
      JSON.stringify({ executionsPerMonth: 10 }),
    ]);
    await pool.query(
      `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 'execution', 8)
       ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = 8`,
      [ws],
    );
    const { fired } = await runAlertSweep({ pool, log: () => {} });
    expect(fired).toBeGreaterThanOrEqual(1);
    const events = await pool.query(`SELECT detail FROM alert_events WHERE workspace_id = $1`, [ws]);
    expect(events.rows[0].detail).toMatchObject({ metric: 'executionsPerMonth', status: 'warn' });
  });

  test('the managed quota rule stays quiet well under the limit', async () => {
    const ws = await seedWorkspace();
    await pool.query(`UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`, [
      ws,
      JSON.stringify({ executionsPerMonth: 1000 }),
    ]);
    await runAlertSweep({ pool, log: () => {} });
    const events = await pool.query(`SELECT count(*)::int AS c FROM alert_events WHERE workspace_id = $1`, [ws]);
    expect(events.rows[0].c).toBe(0);
  });
```

If `seedWorkspace` does not exist in that file, add it:

```ts
async function seedWorkspace(): Promise<string> {
  const user = await createUser(pool, { email: `s-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'S', userId: user!.id });
  return ws.id;
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/scheduler test -- alertSweep.test.ts`
Expected: FAIL — the quota rule evaluates to `null` and nothing fires.

- [ ] **Step 3: Implement the evaluator**

In `apps/scheduler/src/alertSweep.ts`, add imports:

```ts
import { getQuotaUsage, getWorkspacePlan } from '@xperiment/db';
import { evaluateQuota, periodStart, resolveLimits } from '@xperiment/plans';
```

and add a branch at the top of `evaluate`, before the `failure_rate` branch:

```ts
  if (rule.type === 'quota') {
    const plan = await getWorkspacePlan(client, rule.workspaceId);
    const limits = resolveLimits(plan.planCode, plan.limitOverrides);
    const start = periodStart(new Date());
    const usage = await getQuotaUsage(client, rule.workspaceId, start);
    // Report the worst line: blocked outranks warn, and ok never fires.
    const lines = evaluateQuota(limits, usage, plan.allowOverage);
    const worst = lines.find((l) => l.status === 'blocked') ?? lines.find((l) => l.status === 'warn');
    if (!worst) return null;
    return { metric: worst.metric, status: worst.status, used: worst.used, limit: worst.limit };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/scheduler test`
Expected: PASS, the whole scheduler suite.

- [ ] **Step 5: Commit**

```bash
git add apps/scheduler
git commit -m "feat: fire the managed quota alert from the scheduler sweep"
```

---

### Task N-6: Web plan page, banner, e2e, docs, verification and merge

**Files:**
- Create: `apps/web/src/app/(app)/plan/page.tsx`, `apps/web/src/components/shell/QuotaBanner.tsx`
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/components/shell/Sidebar.tsx`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/test/api.test.ts`, `e2e/test/acceptance.test.ts`, `README.md`

**Interfaces:**
- Consumes: `GET /v1/plan`, `PUT /v1/plan` (N-4); `forbiddenDetail` / `PermissionNotice` (Phase 3M).
- Produces: `PlanSnapshot` type and `getPlan` / `updatePlan` client methods.

- [ ] **Step 1: Client methods, test first**

Add to the `apps/web/test/api.test.ts` matrix, after `updateMemberRole`:

```ts
    await client.getPlan();
    await client.updatePlan({ allowOverage: true });
```

and to the `seen` array:

```ts
      'GET /v1/plan',
      'PUT /v1/plan',
```

Run `pnpm --filter @xperiment/web test` → FAIL. Then add to `apps/web/src/lib/api.ts`:

```ts
export interface QuotaLineView {
  metric: 'executionsPerMonth' | 'aiTokensPerMonth' | 'activeWorkflows' | 'members';
  used: number;
  limit: number | null;
  status: 'ok' | 'warn' | 'blocked';
}

export interface PlanSnapshot {
  planCode: string;
  allowOverage: boolean;
  limits: Record<string, number | null>;
  usage: Record<string, number>;
  lines: QuotaLineView[];
  period: { start: string; end: string };
}
```

and, inside the `ApiClient` class:

```ts
  getPlan(): Promise<PlanSnapshot> {
    return this.request('GET', '/v1/plan');
  }

  updatePlan(patch: { planCode?: string; allowOverage?: boolean }): Promise<PlanSnapshot> {
    return this.request('PUT', '/v1/plan', { body: patch });
  }
```

Run again → PASS.

- [ ] **Step 2: Build the plan page**

Create `apps/web/src/app/(app)/plan/page.tsx` (`'use client'`): a `useQuery(['plan'], …)`
with `retry: false`; on `forbiddenDetail` render `<PermissionNotice detail={…} />`. Render
a `q-table` with one row per `line`: metric label, `used` / `limit ?? '∞'`, and a meter
`<div>` whose width is `Math.min(100, limit ? (used / limit) * 100 : 0)%` and whose colour
comes from `status` (`--color-jade` ok, `--color-amber` warn, `--color-coral` blocked).
Above it, a plan switcher `<select data-testid="plan-code">` over the four codes and an
overage checkbox `data-testid="plan-overage"`, both driving a
`useMutation(updatePlan)` that invalidates `['plan']` and shows `err.detail ?? err.title`
in a `q-banner` on `ApiError` (this surfaces the 409 downgrade conflict). Root
`data-testid="plan-page"`; each row `data-testid={`quota-${line.metric}`}`.

- [ ] **Step 3: Banner and nav**

Create `apps/web/src/components/shell/QuotaBanner.tsx`:

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { getBrowserClient } from '../../lib/api';

/** Warns once any limit reaches its soft threshold; silent for a workspace in the clear. */
export function QuotaBanner() {
  const planQ = useQuery({
    queryKey: ['plan'],
    queryFn: () => getBrowserClient().getPlan(),
    retry: false,
    refetchInterval: 60_000,
  });
  const worst = planQ.data?.lines.find((l) => l.status === 'blocked') ?? planQ.data?.lines.find((l) => l.status === 'warn');
  if (!worst) return null;
  return (
    <div className={worst.status === 'blocked' ? 'q-banner' : 'q-banner q-banner--warn'} data-testid="quota-banner">
      <span>
        {worst.metric}: {worst.used} of {worst.limit} used this period.
      </span>
      <Link href="/plan" className="q-btn q-btn--ghost q-btn--sm">
        View plan
      </Link>
    </div>
  );
}
```

Render `<QuotaBanner />` next to `<IncidentBanner />` in `apps/web/src/app/(app)/layout.tsx`,
and add `{ href: '/plan', label: 'Plan' }` to `NAV` in `Sidebar.tsx` after Members.

Run `pnpm --filter @xperiment/web test && pnpm --filter @xperiment/web typecheck && pnpm --filter @xperiment/web build` — all must pass.

- [ ] **Step 4: E2E — cap, refusal, overage**

Append to `e2e/test/acceptance.test.ts`, inside the existing describe:

```ts
  test('a workspace at its execution cap is refused until overage is enabled', async () => {
    const definition = {
      schemaVersion: '0.1',
      workflow: { id: 'wf_quota', name: 'Quota' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        { id: 'done', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: true } } },
      ],
      edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'done', port: 'input' } }],
    };
    const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'Quota' });
    await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
    expect((await api('POST', `/v1/workflows/${created.body.id}/publish`)).status).toBe(201);

    // Pin the cap to what the workspace has already consumed, so the next run is the
    // one that crosses it regardless of what earlier tests ran.
    const wsRow = await pool.query(`SELECT workspace_id FROM workflows WHERE id=$1`, [created.body.id]);
    const ws = (wsRow.rows[0] as { workspace_id: string }).workspace_id;
    const usedRow = await pool.query(
      `SELECT COALESCE(quantity,0) AS q FROM workspace_usage_counters
       WHERE workspace_id=$1 AND metric='execution'
         AND period_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
      [ws],
    );
    const used = Number((usedRow.rows[0] as { q: string } | undefined)?.q ?? 0);
    await pool.query(`UPDATE workspace_plans SET limit_overrides = $2, allow_overage = false WHERE workspace_id = $1`, [
      ws,
      JSON.stringify({ executionsPerMonth: used }),
    ]);

    const blocked = await api('POST', `/v1/workflows/${created.body.id}/execute`, {});
    expect(blocked.status).toBe(402);

    const enabled = await api<{ allowOverage: boolean }>('PUT', '/v1/plan', { allowOverage: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.allowOverage).toBe(true);

    const allowed = await api<{ executionId: string }>('POST', `/v1/workflows/${created.body.id}/execute`, {});
    expect(allowed.status).toBe(201);
    expect((await waitForTerminal(allowed.body.executionId)).execution.status).toBe('SUCCEEDED');

    // Leave the shared e2e workspace unconstrained for whatever runs next.
    await pool.query(`UPDATE workspace_plans SET limit_overrides = '{}'::jsonb WHERE workspace_id = $1`, [ws]);
  }, 60000);
```

Run: `pnpm --filter @xperiment/e2e test` → all green.

- [ ] **Step 5: README**

Add a `## Plans & quota (Phase 3N)` section after the roles section: the four tiers and
their limits as a table; that `null` means unlimited; that flow limits are counted at
execution start while the Usage dashboard reports finalized runs, and why; the seven
enforcement points and their status codes (402 everywhere except the gateway's 429,
which is deliberately generic); `allowOverage`; the managed quota alert rule and that it
can be disabled but not deleted; and `GET`/`PUT /v1/plan`.

- [ ] **Step 6: Full verification**

```bash
docker start postgres redis
pnpm run test:cov      # every package ≥80% on all four metrics
pnpm typecheck
pnpm --filter @xperiment/e2e test
pnpm --filter @xperiment/web e2e
```

If any package dips under 80%, add the missing tests before continuing — do not lower a
threshold.

- [ ] **Step 7: Commit**

```bash
git add apps/web e2e README.md
git commit -m "feat: add the web plan page, quota banner, and quota e2e"
```

- [ ] **Step 8: Adversarial review, then merge**

Run the multi-agent review over `master..HEAD` across four dimensions — **security**
(can a caller spend past a cap; does the gateway leak plan state; can a non-billing role
change a plan; does the downgrade guard hold), **correctness** (the three-statement lock
protocol under concurrency; duplicate requests staying free; counter/ledger divergence;
period rollover; scheduler backlog behaviour), **typescript** (every `createExecutionWithTrigger`
caller handling `quota_exceeded`; `PLAN_CODES`/zod-enum drift; `null`-vs-`0` limit
handling), and **test-gaps** (enforcement points without a test; the parallel test
actually failing without the lock).

Refute each finding independently, fix everything confirmed, re-run the full verification
above, and then re-review the fixes themselves — N's predecessor found a real escalation
only on the second pass. Then:

```bash
git checkout master && git merge --ff-only feature/phase3-plans-quota && git branch -d feature/phase3-plans-quota
```

---

## Self-Review

**Spec coverage.** Catalog + `evaluateQuota` + period boundaries → N-1. Migration 0010,
`workspace_plans`, `workspace_usage_counters`, `alert_rules.managed`, backfill, and the
entitlements repo → N-2. The three-statement lock protocol, the `quota_exceeded` union,
all four execution call sites, the AI-token counter, and the concurrency test → N-3. The
three stock gates, `GET`/`PUT /v1/plan`, the downgrade guard, the managed-delete 409, and
the emptied `UNROUTED` allowlist → N-4. The `quota` evaluator on the existing sweep → N-5.
Web page, banner, e2e, README, verification, review, merge → N-6. The spec's
"documented divergence" between start-counted quota and finalize-counted usage is
covered by N-6 Step 5.

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code; the two prose
steps (N-6 Steps 2 and 5) enumerate exact testids, class names, colour tokens and section
contents rather than saying "build a page".

**Type consistency.** `PlanCode`, `LimitKey`, `PlanLimits`, `QuotaLine` are defined once
in N-1 and imported everywhere after. `CreateExecutionResult`'s `outcome` values
(`'created' | 'duplicate' | 'quota_exceeded'`) are identical in N-3's implementation and
in all four call sites. `incrementUsageCounter`'s `metric` is the DB-level
`CounterMetric` (`'execution' | 'ai_tokens'`), deliberately distinct from the
plan-level `LimitKey` (`'executionsPerMonth' | …`); `COUNTER_TO_LIMIT` in N-2 is the only
place the two are bridged. `getQuotaUsage` returns `Record<LimitKey, number>` in both its
definition (N-2) and its uses (N-3, N-4, N-5).
