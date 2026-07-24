# Usage Metering (Phase 2 Sub-project I) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every billable unit an execution consumes (execution, node, compute_ms, ai_tokens) into an append-only `usage_events` ledger exactly once at finalization, and expose a tenant-scoped real-time usage view (`GET /v1/usage` + web `/usage` page).

**Architecture:** Execution-derived usage rows are inserted inside the same CAS-guarded `withTx` that flips an execution terminal (orchestrator `nodeCompleted`/`watchdog`, API `cancel`) — the exact spot `enqueueCompletionCallback` already fires — making the ledger exactly-once with no separate consumer. AI-token rows are recorded best-effort in the `/v1/ai/*` routes. The view is a live aggregate query.

**Tech Stack:** pnpm monorepo, TypeScript ESM run via tsx, Vitest (v8 coverage ≥80%), PostgreSQL (pg), Fastify, Next.js (Arus design), BullMQ.

## Global Constraints

- Never hardcode secrets; never place secrets in logs/outputs/errors. No `console.log`.
- TDD: failing test first. Coverage ≥80% statements/branches/functions/lines per package.
- Immutability; small focused files (<800 lines). Conventional commits `<type>: <description>`, NO attribution trailer.
- `Db = pg.Pool | pg.PoolClient` (from `packages/db/src/pool.js`). In-tx repo calls receive the tx client.
- Append-only ledger: the usage repo exports insert + read only — no update/delete path.
- Metrics: `'execution' | 'node' | 'compute_ms' | 'ai_tokens'`; quantities are integers (count | count | ms | tokens).
- Migrations auto-apply by sorted filename from `packages/db/src/migrations/*.sql`; next is `0007_usage.sql`.
- Branch `feature/phase2-usage-metering` is already checked out; the spec is committed. Docker Postgres/Redis already running.

---

### Task I-1: DB — usage_events migration + append-only repo (insert, record, summary)

**Files:**
- Create: `packages/db/src/migrations/0007_usage.sql`
- Create: `packages/db/src/repos/usage.ts`
- Modify: `packages/db/src/index.ts` (add `export * from './repos/usage.js';`)
- Test: `packages/db/test/usage.test.ts`

**Interfaces:**
- Consumes: `Db` from `../pool.js`.
- Produces:
  - `type UsageMetric = 'execution' | 'node' | 'compute_ms' | 'ai_tokens'`
  - `interface UsageEventInput { workspaceId: string; metric: UsageMetric; quantity: number; executionId?: string; workflowId?: string; metadata?: Record<string, unknown>; occurredAt: Date }`
  - `insertUsageEvents(db: Db, events: UsageEventInput[]): Promise<void>`
  - `interface RecordExecutionUsageArgs { workspaceId: string; workflowId: string; executionId: string; status: string; nodeCount: number; computeMs: number; occurredAt: Date }`
  - `recordExecutionUsage(db: Db, args: RecordExecutionUsageArgs): Promise<void>`
  - `recordAiUsage(db: Db, args: { workspaceId: string; tokens: number; model: string; kind: string }): Promise<void>`
  - `interface UsageSummary { period: { from: string; to: string }; totals: { executions: number; succeeded: number; failed: number; nodes: number; computeMs: number; aiTokens: number }; series: { date: string; executions: number; nodes: number; computeMs: number; aiTokens: number }[] }`
  - `getUsageSummary(db: Db, args: { workspaceId: string; from: Date; to: Date }): Promise<UsageSummary>`

- [ ] **Step 1: Write the migration**

Create `packages/db/src/migrations/0007_usage.sql`:

```sql
CREATE TABLE usage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  metric        TEXT NOT NULL,
  quantity      BIGINT NOT NULL,
  execution_id  UUID NULL,
  workflow_id   UUID NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_events_workspace ON usage_events (workspace_id, occurred_at DESC);
```

- [ ] **Step 2: Write the failing test**

Create `packages/db/test/usage.test.ts`:

```ts
import { createPool, getUsageSummary, insertUsageEvents, recordAiUsage, recordExecutionUsage, runMigrations } from '../src/index.js';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

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
    const rows = await pool.query(`SELECT metric, quantity, metadata->>'status' AS status FROM usage_events ORDER BY metric`);
    // execution(SUCCEEDED)+node+compute for run 1, execution(CANCELED) only for run 2 (0-qty omitted)
    const metrics = rows.rows.map((r) => (r as { metric: string }).metric).sort();
    expect(metrics).toEqual(['compute_ms', 'execution', 'execution', 'node']);
  });
});

describe('recordAiUsage', () => {
  test('writes one ai_tokens row and skips zero tokens', async () => {
    await recordAiUsage(pool, { workspaceId: WS, tokens: 350, model: 'm', kind: 'generate' });
    await recordAiUsage(pool, { workspaceId: WS, tokens: 0, model: 'm', kind: 'edit' });
    const rows = await pool.query(`SELECT quantity, metadata FROM usage_events WHERE metric='ai_tokens'`);
    expect(rows.rowCount).toBe(1);
    expect(Number((rows.rows[0] as { quantity: string }).quantity)).toBe(350);
  });
});

describe('getUsageSummary', () => {
  test('aggregates totals and daily series within the period, tenant-scoped', async () => {
    const other = '00000000-0000-0000-0000-000000000009';
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

  test('empty period returns zeroed totals and empty series', async () => {
    const s = await getUsageSummary(pool, { workspaceId: WS, from: at('2026-01-01T00:00:00Z'), to: at('2026-01-02T00:00:00Z') });
    expect(s.totals).toEqual({ executions: 0, succeeded: 0, failed: 0, nodes: 0, computeMs: 0, aiTokens: 0 });
    expect(s.series).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @xperiment/db test -- usage.test.ts`
Expected: FAIL — `insertUsageEvents`/`recordExecutionUsage`/`recordAiUsage`/`getUsageSummary` not exported.

- [ ] **Step 4: Implement the repo**

Create `packages/db/src/repos/usage.ts`:

```ts
import { type Db } from '../pool.js';

export type UsageMetric = 'execution' | 'node' | 'compute_ms' | 'ai_tokens';

export interface UsageEventInput {
  workspaceId: string;
  metric: UsageMetric;
  quantity: number;
  executionId?: string;
  workflowId?: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

/** Append rows to the immutable usage ledger. No-op on an empty batch. */
export async function insertUsageEvents(db: Db, events: UsageEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  events.forEach((e, i) => {
    const b = i * 6;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
    params.push(e.workspaceId, e.metric, e.quantity, e.executionId ?? null, e.workflowId ?? null, JSON.stringify(e.metadata ?? {}));
  });
  // occurred_at is passed separately per row via a parallel array to keep the VALUES simple.
  const occurred: Date[] = events.map((e) => e.occurredAt);
  const rows = values
    .map((v, i) => v.replace(/\)$/, `,$${events.length * 6 + i + 1})`))
    .join(',');
  await db.query(
    `INSERT INTO usage_events (workspace_id, metric, quantity, execution_id, workflow_id, metadata, occurred_at) VALUES ${rows}`,
    [...params, ...occurred],
  );
}

export interface RecordExecutionUsageArgs {
  workspaceId: string;
  workflowId: string;
  executionId: string;
  status: string;
  nodeCount: number;
  computeMs: number;
  occurredAt: Date;
}

/** Emit the standard row-set for a finalized execution (0-quantity node/compute rows omitted). */
export async function recordExecutionUsage(db: Db, args: RecordExecutionUsageArgs): Promise<void> {
  const base = { workspaceId: args.workspaceId, workflowId: args.workflowId, executionId: args.executionId, occurredAt: args.occurredAt };
  const events: UsageEventInput[] = [
    { ...base, metric: 'execution', quantity: 1, metadata: { status: args.status } },
  ];
  if (args.nodeCount > 0) events.push({ ...base, metric: 'node', quantity: args.nodeCount });
  if (args.computeMs > 0) events.push({ ...base, metric: 'compute_ms', quantity: args.computeMs });
  await insertUsageEvents(db, events);
}

/** Record AI token usage for one generation call. Skips a zero/negative count. */
export async function recordAiUsage(
  db: Db,
  args: { workspaceId: string; tokens: number; model: string; kind: string },
): Promise<void> {
  if (args.tokens <= 0) return;
  await insertUsageEvents(db, [
    { workspaceId: args.workspaceId, metric: 'ai_tokens', quantity: args.tokens, metadata: { model: args.model, kind: args.kind }, occurredAt: new Date() },
  ]);
}

export interface UsageSummary {
  period: { from: string; to: string };
  totals: { executions: number; succeeded: number; failed: number; nodes: number; computeMs: number; aiTokens: number };
  series: { date: string; executions: number; nodes: number; computeMs: number; aiTokens: number }[];
}

export async function getUsageSummary(
  db: Db,
  args: { workspaceId: string; from: Date; to: Date },
): Promise<UsageSummary> {
  const params = [args.workspaceId, args.from.toISOString(), args.to.toISOString()];
  const totalsRes = await db.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution'),0)::bigint AS executions,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution' AND metadata->>'status'='SUCCEEDED'),0)::bigint AS succeeded,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution' AND metadata->>'status'='FAILED'),0)::bigint AS failed,
       COALESCE(SUM(quantity) FILTER (WHERE metric='node'),0)::bigint AS nodes,
       COALESCE(SUM(quantity) FILTER (WHERE metric='compute_ms'),0)::bigint AS compute_ms,
       COALESCE(SUM(quantity) FILTER (WHERE metric='ai_tokens'),0)::bigint AS ai_tokens
     FROM usage_events WHERE workspace_id=$1 AND occurred_at >= $2 AND occurred_at < $3`,
    params,
  );
  const seriesRes = await db.query(
    `SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution'),0)::bigint AS executions,
       COALESCE(SUM(quantity) FILTER (WHERE metric='node'),0)::bigint AS nodes,
       COALESCE(SUM(quantity) FILTER (WHERE metric='compute_ms'),0)::bigint AS compute_ms,
       COALESCE(SUM(quantity) FILTER (WHERE metric='ai_tokens'),0)::bigint AS ai_tokens
     FROM usage_events WHERE workspace_id=$1 AND occurred_at >= $2 AND occurred_at < $3
     GROUP BY 1 ORDER BY 1`,
    params,
  );
  const t = totalsRes.rows[0] as Record<string, string>;
  const n = (v: string | undefined) => Number(v ?? 0);
  return {
    period: { from: args.from.toISOString(), to: args.to.toISOString() },
    totals: {
      executions: n(t['executions']), succeeded: n(t['succeeded']), failed: n(t['failed']),
      nodes: n(t['nodes']), computeMs: n(t['compute_ms']), aiTokens: n(t['ai_tokens']),
    },
    series: (seriesRes.rows as Record<string, string>[]).map((r) => ({
      date: r['date']!, executions: n(r['executions']), nodes: n(r['nodes']),
      computeMs: n(r['compute_ms']), aiTokens: n(r['ai_tokens']),
    })),
  };
}
```

Add to `packages/db/src/index.ts` after the other repo exports:

```ts
export * from './repos/usage.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @xperiment/db test -- usage.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 6: Verify the whole db package + typecheck**

Run: `pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/migrations/0007_usage.sql packages/db/src/repos/usage.ts packages/db/src/index.ts packages/db/test/usage.test.ts
git commit -m "feat: add append-only usage_events ledger repo"
```

---

### Task I-2: Orchestrator + watchdog — emit execution usage at finalization

**Files:**
- Modify: `apps/orchestrator/src/handlers/nodeCompleted.ts` (3 terminal branches)
- Modify: `apps/orchestrator/src/handlers/watchdog.ts` (TIMED_OUT branch)
- Test: `apps/orchestrator/test/nodeCompleted.test.ts` (extend), `apps/orchestrator/test/watchdog.test.ts` (extend)

**Interfaces:**
- Consumes: `recordExecutionUsage` from `@xperiment/db`; `ctx.execution.startedAt` (string|null), `ctx.execution.workflowId`, `ctx.execution.workspaceId` (added in Step 0); `states` from `latestNodeStates`.
- Produces: usage rows written in the same tx as finalization.

Helper for node count and duration (define inline in each handler, do NOT export):
`const ranCount = states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length;`
`const computeMs = ctx.execution.startedAt ? Date.now() - new Date(ctx.execution.startedAt).getTime() : 0;`

- [ ] **Step 0: Add `workspaceId` to `ExecutionRow` (prerequisite)**

`ExecutionRow` does NOT currently expose `workspaceId`, but `getExecutionDetail` does `SELECT * FROM executions` so the column is in the row. In `packages/db/src/repos/executions.ts`, add `workspaceId: string;` to the `ExecutionRow` interface (after `id`) and `workspaceId: r['workspace_id'] as string,` to `mapExecution`. This is consumed by `ctx.execution.workspaceId` / `detail.execution.workspaceId` in this task and Task I-3. Run `pnpm --filter @xperiment/db typecheck` after — no test needed (additive field; existing tests unaffected). Commit is folded into Step 7.

- [ ] **Step 1: Write the failing test (nodeCompleted)**

Add to `apps/orchestrator/test/nodeCompleted.test.ts` (reuse the file's existing seed helpers; assert against `usage_events`). Example test:

```ts
test('records execution usage exactly once on SUCCEEDED (duplicate delivery does not double-count)', async () => {
  const { executionId, workflowId } = await seedSingleNodeRunning(); // existing/near-existing helper
  const payload = { executionId, nodeId: 't', attempt: 1, status: 'SUCCEEDED' as const, outputPort: 'main' };
  await handleNodeCompleted(deps, payload);
  await handleNodeCompleted(deps, payload); // redelivery — CAS guard must prevent a 2nd execution row
  const rows = await pool.query(
    `SELECT metric, quantity, metadata->>'status' AS status FROM usage_events WHERE execution_id=$1`,
    [executionId],
  );
  const exec = rows.rows.filter((r) => (r as { metric: string }).metric === 'execution');
  expect(exec).toHaveLength(1);
  expect((exec[0] as { status: string }).status).toBe('SUCCEEDED');
});
```

> If `nodeCompleted.test.ts` lacks a single-node terminal seed helper, add one modeled on the existing multi-node seed (insert workflow + version whose IR is one `manual.trigger` node `t`, an execution in RUNNING with `started_at = now()`, and node `t` in SUCCEEDED so readiness resolves terminal). Assert the usage row as above.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/orchestrator test -- nodeCompleted.test.ts`
Expected: FAIL — no `usage_events` rows (0 execution rows).

- [ ] **Step 3: Implement — nodeCompleted emission**

In `apps/orchestrator/src/handlers/nodeCompleted.ts`, add `recordExecutionUsage` to the import from `@xperiment/db`. In the direct-FAILED branch (`if (failed) { … }`), after `enqueueCompletionCallback`:

```ts
await recordExecutionUsage(client, {
  workspaceId: ctx.execution.workspaceId,
  workflowId: ctx.execution.workflowId,
  executionId,
  status: 'FAILED',
  nodeCount: states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
  computeMs: ctx.execution.startedAt ? Date.now() - new Date(ctx.execution.startedAt).getTime() : 0,
  occurredAt: new Date(),
});
```

In the SUCCEEDED terminal branch (`if (done) { … }` after `to:'SUCCEEDED'`), after `enqueueCompletionCallback`:

```ts
await recordExecutionUsage(client, {
  workspaceId: ctx.execution.workspaceId,
  workflowId: ctx.execution.workflowId,
  executionId,
  status: 'SUCCEEDED',
  nodeCount: states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
  computeMs: ctx.execution.startedAt ? Date.now() - new Date(ctx.execution.startedAt).getTime() : 0,
  occurredAt: new Date(),
});
```

In the readiness-FAILED terminal branch (`if (done) { … }` after `to:'FAILED'`), after `enqueueCompletionCallback`:

```ts
await recordExecutionUsage(client, {
  workspaceId: ctx.execution.workspaceId,
  workflowId: ctx.execution.workflowId,
  executionId,
  status: 'FAILED',
  nodeCount: states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
  computeMs: ctx.execution.startedAt ? Date.now() - new Date(ctx.execution.startedAt).getTime() : 0,
  occurredAt: new Date(),
});
```

> Note: `ctx.execution.workspaceId` must exist on the `ExecutionRow`. If `loadExecutionContext`'s row lacks `workspaceId`, add it to the `getExecutionDetail` execution mapping in `packages/db/src/repos/executions.ts` (select `workspace_id` and map to `workspaceId`) — verify first with a quick read; the execution row already carries `workflowId`/`workflowVersionId`, so `workspaceId` is likely present.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @xperiment/orchestrator test -- nodeCompleted.test.ts`
Expected: PASS (exactly one execution row, no double-count).

- [ ] **Step 5: Write the failing test (watchdog)**

Add to `apps/orchestrator/test/watchdog.test.ts` a test that seeds a RUNNING execution past timeout with no open waits, runs `handleWatchdog`, and asserts a `usage_events` `execution` row with `status='TIMED_OUT'` exists.

- [ ] **Step 6: Run to verify it fails, then implement watchdog emission**

In `apps/orchestrator/src/handlers/watchdog.ts`, add `recordExecutionUsage` to the `@xperiment/db` import and, inside `if (timedOut) { … }` after `enqueueCompletionCallback`:

```ts
await recordExecutionUsage(client, {
  workspaceId: ctx.execution.workspaceId,
  workflowId: ctx.execution.workflowId,
  executionId,
  status: 'TIMED_OUT',
  nodeCount: states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
  computeMs: ctx.execution.startedAt ? Date.now() - new Date(ctx.execution.startedAt).getTime() : 0,
  occurredAt: new Date(),
});
```

Run: `pnpm --filter @xperiment/orchestrator test -- watchdog.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify package + typecheck + commit**

```bash
pnpm --filter @xperiment/orchestrator test && pnpm --filter @xperiment/orchestrator typecheck
git add apps/orchestrator/src/handlers/nodeCompleted.ts apps/orchestrator/src/handlers/watchdog.ts apps/orchestrator/test/nodeCompleted.test.ts apps/orchestrator/test/watchdog.test.ts
git commit -m "feat: emit execution usage at orchestrator finalization"
```

---

### Task I-3: API — cancel emission + GET /v1/usage

**Files:**
- Modify: `apps/api/src/routes/executions.ts` (cancel path: emit usage; add `recordExecutionUsage` import)
- Create: `apps/api/src/routes/usage.ts`
- Modify: `apps/api/src/server.ts` (register `registerUsageRoutes`)
- Test: `apps/api/test/usage.test.ts` (new); extend `apps/api/test/executionsControl.test.ts`

**Interfaces:**
- Consumes: `recordExecutionUsage`, `getUsageSummary` from `@xperiment/db`; `authOf`, `roleGate`; `sendProblem`.
- Produces: `GET /v1/usage?from&to` → `UsageSummary`; a `usage_events` execution row on cancel (`status='CANCELED'`).

- [ ] **Step 1: Write the failing test (cancel emission)**

Add to `apps/api/test/executionsControl.test.ts` in the cancel describe:

```ts
test('records a CANCELED execution usage row on cancel', async () => {
  const { executionId } = await seedRunning(auth.workspaceId);
  await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/cancel` });
  const rows = await pool.query(
    `SELECT metadata->>'status' AS status FROM usage_events WHERE execution_id=$1 AND metric='execution'`,
    [executionId],
  );
  expect(rows.rowCount).toBe(1);
  expect((rows.rows[0] as { status: string }).status).toBe('CANCELED');
});
```

(Ensure the `beforeEach` TRUNCATE in that file includes `usage_events` — add it to the truncate list.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/api test -- executionsControl.test.ts`
Expected: FAIL — 0 rows.

- [ ] **Step 3: Implement cancel emission**

In `apps/api/src/routes/executions.ts`, add `recordExecutionUsage` to the `@xperiment/db` import. In the cancel `withTx`, after `enqueueCompletionCallback(...)` and before the closing brace:

```ts
await recordExecutionUsage(client, {
  workspaceId: ctx.workspaceId,
  workflowId: detail.execution.workflowId,
  executionId: id,
  status: 'CANCELED',
  nodeCount: states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
  computeMs: detail.execution.startedAt ? Date.now() - new Date(detail.execution.startedAt).getTime() : 0,
  occurredAt: new Date(),
});
```

(`states` is already loaded in the cancel tx via `latestNodeStates(client, id)`.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @xperiment/api test -- executionsControl.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test (GET /v1/usage)**

Create `apps/api/test/usage.test.ts`:

```ts
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, insertUsageEvents, runMigrations } from '@xperiment/db';
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
  await pool.query(`TRUNCATE usage_events`);
});

describe('GET /v1/usage', () => {
  test('returns tenant-scoped totals within the default period', async () => {
    const now = new Date();
    await insertUsageEvents(pool, [
      { workspaceId: auth.workspaceId, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: now },
      { workspaceId: auth.workspaceId, metric: 'node', quantity: 2, occurredAt: now },
    ]);
    const r = await auth.inject({ method: 'GET', url: '/v1/usage' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ totals: { executions: number; nodes: number } }>();
    expect(body.totals.executions).toBe(1);
    expect(body.totals.nodes).toBe(2);
  });

  test('excludes another workspace usage', async () => {
    const other = await createAuthedUser(app);
    await insertUsageEvents(pool, [
      { workspaceId: other.workspaceId, metric: 'execution', quantity: 5, metadata: { status: 'SUCCEEDED' }, occurredAt: new Date() },
    ]);
    const r = await auth.inject({ method: 'GET', url: '/v1/usage' });
    expect(r.json<{ totals: { executions: number } }>().totals.executions).toBe(0);
  });

  test('rejects an inverted range', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/usage?from=2026-07-10&to=2026-07-01' });
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @xperiment/api test -- usage.test.ts`
Expected: FAIL — route not registered (404).

- [ ] **Step 7: Implement the usage route**

Create `apps/api/src/routes/usage.ts`:

```ts
import { getUsageSummary } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function registerUsageRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/usage', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid query', parsed.error.message);
    const now = new Date();
    const from = parsed.data.from ?? startOfUtcMonth(now);
    const to = parsed.data.to ?? now;
    if (from.getTime() >= to.getTime()) {
      return sendProblem(reply, 400, 'Invalid range', 'from must be before to');
    }
    return getUsageSummary(deps.pool, { workspaceId: authOf(req).workspaceId, from, to });
  });
}
```

Register in `apps/api/src/server.ts`: import `registerUsageRoutes` and call it alongside the other `register*Routes(app, deps)` calls (after auth/rate-limit registration, with the other route groups).

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm --filter @xperiment/api test -- usage.test.ts`
Expected: PASS.

- [ ] **Step 9: Verify api package + typecheck + commit**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/executions.ts apps/api/src/routes/usage.ts apps/api/src/server.ts apps/api/test/usage.test.ts apps/api/test/executionsControl.test.ts
git commit -m "feat: add GET /v1/usage and cancel usage emission"
```

---

### Task I-4: AI token passthrough + best-effort metering

**Files:**
- Modify: `packages/ai/src/openrouter.ts` (surface `usage`)
- Modify: `packages/ai/src/generate.ts` (accumulate + return `tokensUsed`)
- Test: `packages/ai/test/generate.test.ts` (extend), `packages/ai/test/openrouter.test.ts` (extend if present)
- Modify: `apps/api/src/routes/ai.ts` (record best-effort)
- Test: `apps/api/test/ai.test.ts` (extend — assert an `ai_tokens` row)

**Interfaces:**
- Produces: `ChatClient.chat` returns `{ content: string; usage: TokenUsage }` where `interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number }`; `GenerateResult` gains `tokensUsed: number`.
- Consumes: `recordAiUsage` from `@xperiment/db` in the AI route.

> Design note: changing `chat` from returning `string` to `{ content, usage }` is a breaking internal change; update `generate.ts` (the only caller) in the same task. Keep `TokenUsage` zeroed when the provider omits `usage`.

- [ ] **Step 1: Write the failing test (client surfaces usage)**

Add to the ai client test (e.g. `packages/ai/test/openrouter.test.ts`, create if absent) a stubbed-`fetchImpl` case returning `{ choices:[{message:{content:'{}'}}], usage:{prompt_tokens:10, completion_tokens:5, total_tokens:15} }` and assert `chat(...)` resolves `{ content: '{}', usage: { promptTokens:10, completionTokens:5, totalTokens:15 } }`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/ai test`
Expected: FAIL (chat returns a string / no usage).

- [ ] **Step 3: Implement client usage passthrough**

In `packages/ai/src/openrouter.ts`:

```ts
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage;
}

export interface ChatClient {
  chat(messages: ChatMessage[], opts?: { responseSchema?: unknown }): Promise<ChatResult>;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
```

At the end of `chat`, replace `return content;` with:

```ts
const u = data.usage ?? {};
return {
  content,
  usage: {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  },
};
```

- [ ] **Step 4: Update generate.ts to accumulate tokens**

In `packages/ai/src/generate.ts`, add `tokensUsed: number` to `GenerateResult`. Track a running total and use `.content` from `chat`:

```ts
let tokensUsed = 0;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const res = await deps.client.chat(messages);
  tokensUsed += res.usage.totalTokens;
  const content = res.content;
  // …existing extractJson(content) / validate flow…
  if (result.valid && result.ir) {
    return { ir: result.ir, findings: [], attempts: attempt, tokensUsed };
  }
  // …
}
return { findings: lastFindings, attempts: maxAttempts, tokensUsed };
```

Update the failure/return sites so every `return` includes `tokensUsed`.

- [ ] **Step 5: Fix existing ai tests + run**

Existing ai tests that stub `chat` to return a string must return `{ content, usage: { promptTokens:0, completionTokens:0, totalTokens:0 } }`. Update those stubs.

Run: `pnpm --filter @xperiment/ai test`
Expected: PASS.

- [ ] **Step 6: Write the failing test (route records ai_tokens)**

In `apps/api/test/ai.test.ts`, in the test that stubs a successful generation (via `aiClientFactory`), have the stub client return usage `totalTokens: 42`, call `POST /v1/ai/generate`, and assert a `usage_events` row with `metric='ai_tokens'` and `quantity=42` for the workspace. (Add `TRUNCATE usage_events` to that file's `beforeEach` if it truncates.)

- [ ] **Step 7: Run to verify it fails, then implement route metering**

In `apps/api/src/routes/ai.ts`: import `recordAiUsage` from `@xperiment/db`. Thread `kind` into `handle` (`'generate'` | `'edit'`). After a successful `result.ir`, before returning 200:

```ts
try {
  await recordAiUsage(deps.pool, { workspaceId, tokens: result.tokensUsed, model: deps.ai.model, kind });
} catch (e) {
  reply.log.warn({ err: (e as Error).message }, 'usage.ai_record_failed');
}
```

`ResolvedServerDeps` has no logger, so use Fastify's per-request `reply.log` (already available in the `handle(reply, …)` helper). Do NOT swallow silently without a log line.

Run: `pnpm --filter @xperiment/api test -- ai.test.ts`
Expected: PASS.

- [ ] **Step 8: Verify ai + api + typecheck + commit**

```bash
pnpm --filter @xperiment/ai test && pnpm --filter @xperiment/api test && pnpm typecheck
git add packages/ai/src/openrouter.ts packages/ai/src/generate.ts packages/ai/test apps/api/src/routes/ai.ts apps/api/test/ai.test.ts
git commit -m "feat: meter AI token usage best-effort"
```

---

### Task I-5: Web Usage page + client + nav, e2e, docs, full verification, review, merge

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`getUsage` + `UsageSummary` type)
- Create: `apps/web/src/app/(app)/usage/page.tsx`
- Modify: `apps/web/src/components/shell/Sidebar.tsx` (add Usage nav item)
- Test: `apps/web/test/api.test.ts` (extend matrix)
- Modify: `e2e/test/acceptance.test.ts` (usage assertion)
- Modify: `README.md` (Usage metering section)

**Interfaces:**
- Consumes: `GET /v1/usage` returning `UsageSummary` (matches the db type: `{ period, totals:{executions,succeeded,failed,nodes,computeMs,aiTokens}, series:[{date,executions,nodes,computeMs,aiTokens}] }`).

- [ ] **Step 1: Write the failing test (client method)**

In `apps/web/test/api.test.ts`, add `await client.getUsage();` to the method matrix and expect `GET /v1/usage` in the `seen` array (place it consistently in the sequence).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/web test -- api.test.ts`
Expected: FAIL — `getUsage` not a function / endpoint missing.

- [ ] **Step 3: Implement the client method + type**

In `apps/web/src/lib/api.ts` add the type and method:

```ts
export interface UsageSummary {
  period: { from: string; to: string };
  totals: { executions: number; succeeded: number; failed: number; nodes: number; computeMs: number; aiTokens: number };
  series: { date: string; executions: number; nodes: number; computeMs: number; aiTokens: number }[];
}
```

```ts
getUsage(params?: { from?: string; to?: string }): Promise<UsageSummary> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const s = qs.toString();
  return this.request('GET', `/v1/usage${s ? `?${s}` : ''}`);
}
```

Run: `pnpm --filter @xperiment/web test -- api.test.ts` → PASS.

- [ ] **Step 4: Build the Usage page**

Create `apps/web/src/app/(app)/usage/page.tsx` (`'use client'`) — a container using `useQuery(['usage'], () => getBrowserClient().getUsage())` that renders Arus scorecards (Runs = totals.executions, Success rate = succeeded/executions as %, Nodes, Compute = fmt ms→s/min, AI tokens) and a daily bar chart of `series[].executions` using inline CSS-height bars (no new dependency). Loading/empty/error states like the executions page. Reuse `fmtDuration`/format helpers where sensible (compute a `fmtMs` inline if needed). Give the page a `data-testid="usage-page"` root and scorecards `data-testid` hooks.

- [ ] **Step 5: Add the nav item**

In `apps/web/src/components/shell/Sidebar.tsx`, add to `NAV` after Executions:

```ts
{ href: '/usage', label: 'Usage' },
```

- [ ] **Step 6: Web build + typecheck**

Run: `pnpm --filter @xperiment/web build && pnpm --filter @xperiment/web typecheck`
Expected: build succeeds, types clean.

- [ ] **Step 7: E2E usage assertion**

In `e2e/test/acceptance.test.ts`, in a test that runs a workflow to a terminal state, add after the run completes:

```ts
const usage = await api('GET', '/v1/usage');
expect(usage.totals.executions).toBeGreaterThanOrEqual(1);
expect(usage.totals.nodes).toBeGreaterThanOrEqual(1);
```

(Use the suite's existing `api()` helper and auth context; if the workflow has ≥1 node that runs, nodes ≥ 1.)

- [ ] **Step 8: README + docs**

Add a "## Usage metering (Phase 2I)" section to `README.md`: append-only `usage_events` ledger emitted at finalization (execution/node/compute) + best-effort AI tokens; `GET /v1/usage?from&to` (defaults to current UTC month) returns totals + daily series; web `/usage` page.

- [ ] **Step 9: Full workspace verification**

```bash
pnpm run test:cov      # all packages ≥80% thresholds
pnpm typecheck         # clean
pnpm --filter @xperiment/e2e test        # backend e2e incl. usage assertion
pnpm --filter @xperiment/web e2e         # web e2e
```

Expected: all green; coverage thresholds hold (add targeted tests if the new `usage.ts`/route branches dip a package under 80%).

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/api.ts "apps/web/src/app/(app)/usage/page.tsx" apps/web/src/components/shell/Sidebar.tsx apps/web/test/api.test.ts e2e/test/acceptance.test.ts README.md
git commit -m "feat: add web Usage page, client, e2e, and docs"
```

- [ ] **Step 11: Adversarial review + merge**

Run the adversarial multi-dimension review (security: tenant scoping on `GET /v1/usage`, no secret/PII in ledger metadata, SQL-injection surface of the aggregate; correctness: exactly-once emission across all four terminal paths + no double-count on redelivery, compute_ms sign/overflow, period boundary `< to`; typescript: bigint→number narrowing, the `chat` return-type change fallout; test-gaps: watchdog/cancel emission coverage, AI best-effort failure path). Triage confirmed findings, fix CRITICAL/HIGH, re-verify. Then:

```bash
git checkout master && git merge --ff-only feature/phase2-usage-metering && git branch -d feature/phase2-usage-metering
```

---

## Self-Review

**Spec coverage:** BILL-001 append-only ledger → Task I-1 (`usage_events`, insert-only surface) + emission Tasks I-2/I-3/I-4. BILL-002 near-real-time view → Task I-3 (`GET /v1/usage`) + Task I-5 (web page). All four metrics (execution/node/compute_ms/ai_tokens) covered: execution/node/compute in I-2/I-3, ai_tokens in I-4. Exactly-once → I-2 duplicate-delivery test. Tenant-scoping → I-3 cross-workspace test.

**Placeholder scan:** No TBD/TODO; every code step shows real code. Both prior open questions are now resolved with concrete steps: `ExecutionRow.workspaceId` is added explicitly in Task I-2 Step 0; the AI route logs via Fastify `reply.log` (verified `ResolvedServerDeps` has no logger).

**Type consistency:** `UsageSummary` is defined identically in I-1 (db) and reused in I-3 (route return) and I-5 (web type mirror). `recordExecutionUsage`/`recordAiUsage`/`getUsageSummary`/`insertUsageEvents` signatures match across I-1 → I-2/I-3/I-4. `ChatResult`/`TokenUsage`/`tokensUsed` introduced in I-4 and consumed only there.
