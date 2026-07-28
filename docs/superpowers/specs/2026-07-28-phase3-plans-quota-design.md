# Phase 3 Sub-project N — Plans, Entitlements & Quota Enforcement

**Status:** Approved (design gate 2026-07-28)
**PRD:** BILL-003 (soft limit, hard limit, overage policy), BILL-004 (plan entitlement service), WS-009 (quota dan usage limit per workspace)
**Depends on:** Phase 2I (append-only `usage_events` ledger), Phase 2J (alert rules/events + delivery), Phase 3M (capability RBAC — `billing:read` / `billing:manage` are declared with no routes)

## Goal

Give every workspace a plan, derive limits from it, and refuse work that would exceed
them — warning before blocking, and letting an admin opt into metered overage instead.

The PRD's tier table is explicitly a hypothesis ("Pricing final memerlukan customer
discovery dan cost modeling"). N therefore builds the **mechanism**, not a committed
commercial ladder: the catalog is one small data structure that a later slice can
replace with rows from a billing provider without touching a single enforcement site.

## Scope

**Four limits**, each backed by something the codebase can already count:

| Limit | Kind | Source |
|---|---|---|
| `executionsPerMonth` | flow | `workspace_usage_counters`, incremented at execution start |
| `aiTokensPerMonth` | flow | `workspace_usage_counters`, incremented in `recordAiUsage` |
| `activeWorkflows` | stock | `count(*) FROM workflows WHERE active` |
| `members` | stock | `count(*) FROM workspace_members` |

**Out of scope:** invoices and payment (sub-project O), concurrency and storage limits,
cost attribution per workflow (BILL-006), committed usage (BILL-008). Changing plan is
self-serve and unpriced in N — O attaches money to it.

## Architecture

### `packages/plans` — pure policy, no I/O

A new package, peer to `@xperiment/ir` and `@xperiment/engine-core`. It is separate rather than
folded into `apps/api` because the API, gateway, and scheduler all enforce, and none of
them may import from another app.

```ts
export type PlanCode = 'free' | 'builder' | 'team' | 'business';
export type LimitKey = 'executionsPerMonth' | 'aiTokensPerMonth' | 'activeWorkflows' | 'members';

/** null = unlimited. */
export type PlanLimits = Record<LimitKey, number | null>;

export const PLAN_CATALOG: Record<PlanCode, PlanLimits> = {
  free:     { executionsPerMonth: 500,    aiTokensPerMonth: 50_000,    activeWorkflows: 3,    members: 2 },
  builder:  { executionsPerMonth: 10_000, aiTokensPerMonth: 500_000,   activeWorkflows: 20,   members: 3 },
  team:     { executionsPerMonth: 50_000, aiTokensPerMonth: 2_000_000, activeWorkflows: 100,  members: 15 },
  business: { executionsPerMonth: null,   aiTokensPerMonth: null,      activeWorkflows: null, members: null },
};

export const SOFT_LIMIT_RATIO = 0.8;

export type QuotaStatus = 'ok' | 'warn' | 'blocked';
export interface QuotaLine { metric: LimitKey; used: number; limit: number | null; status: QuotaStatus }

export function resolveLimits(code: PlanCode, overrides: Partial<PlanLimits>): PlanLimits;
export function evaluateQuota(limits: PlanLimits, used: Record<LimitKey, number>, allowOverage: boolean): QuotaLine[];
export function isBlocked(lines: QuotaLine[], metric: LimitKey): boolean;
```

`evaluateQuota` rules, in order:
1. `limit === null` → `ok` (unlimited).
2. `used >= limit` → `blocked`, unless `allowOverage` → `warn`.
3. `used >= limit * SOFT_LIMIT_RATIO` → `warn`.
4. otherwise → `ok`.

Enterprise is `business` plus `limit_overrides`; there is no separate code.

### Migration 0010

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

-- Backfill: every existing workspace gets a free plan and a managed quota rule.
INSERT INTO workspace_plans (workspace_id) SELECT id FROM workspaces
  ON CONFLICT (workspace_id) DO NOTHING;
```

The `alert_rules.type` domain gains `'quota'`. (0008 declared `type` as bare `TEXT` with
no CHECK, so this needs no constraint change — only the zod union in the API widens.)

### Counting: flows are counted where they happen

`workspace_usage_counters` is incremented **in the same transaction as the event it
counts**, so the counter and the fact can never disagree:

- `createExecutionWithTrigger` — `UPSERT … quantity = quantity + 1` for metric
  `execution`, inside the existing `withTx`, alongside the execution insert.
- `recordAiUsage` — same, for metric `ai_tokens`.

**Why start-time and not the ledger.** Phase 2I records usage when an execution
*finalizes*. Checking that would leave a burst hole: a workspace at 999/1000 could start
500 concurrent runs and every check would pass, because none had finalized yet. The
quota counter therefore counts execution **starts**, and the check and increment share
one transaction so the boundary holds under concurrency.

**Documented divergence.** Quota counts starts; the Usage dashboard (Phase 2I) reports
finalized executions. A run in flight counts against quota but not yet against the
dashboard. The `/plan` page labels its numbers "consumed this period" for that reason.

**The ledger stays the source of truth.** Counters are a derived index.
`recomputeCounters(db, workspaceId, periodStart)` rebuilds them by aggregating
`usage_events`, so drift is detectable and repairable rather than silent. BILL-001's
append-only guarantee is untouched.

Period boundaries are UTC calendar months, matching `getUsageSummary`'s default window.
`periodStart(now)` in `packages/plans` is the single definition, used by both the
counter writes and the reads.

### Stocks are counted live

Active workflows and members are current-state gauges, not accumulations. They are
`count(*)` at check time — nothing to increment, nothing to drift, and the check runs
only on the rare authoring actions (`activate`, invite) rather than on every run.

### `packages/db/src/repos/entitlements.ts`

```ts
export interface WorkspacePlanRow { workspaceId: string; planCode: PlanCode; limitOverrides: Partial<PlanLimits>; allowOverage: boolean }

export async function getWorkspacePlan(db: Db, workspaceId: string): Promise<WorkspacePlanRow>;      // free-plan default if no row
export async function setWorkspacePlan(db: Db, args: { workspaceId: string; planCode?: PlanCode; allowOverage?: boolean }): Promise<WorkspacePlanRow>;
/** All four numbers: the two flow metrics from the counter rows, the two stocks from live count(*). */
export async function getQuotaUsage(db: Db, workspaceId: string, periodStart: Date): Promise<Record<LimitKey, number>>;
export async function incrementUsageCounter(db: Db, args: { workspaceId: string; periodStart: Date; metric: 'execution' | 'ai_tokens'; quantity: number }): Promise<void>;
export async function recomputeCounters(db: Db, workspaceId: string, periodStart: Date): Promise<void>;
```

`getWorkspacePlan` returns the `free` defaults when no row exists, so a workspace created
before 0010 (or by a code path that forgets the insert) is limited rather than unlimited —
the fail-closed rule that governs authorization applies to spend too.

## Enforcement

### The refusal cannot be ignored

`createExecutionWithTrigger`'s return type becomes a discriminated union:

```ts
type CreateExecutionResult =
  | { outcome: 'created' | 'duplicate'; execution: ExecutionRow }
  | { outcome: 'quota_exceeded'; metric: LimitKey; used: number; limit: number };
```

Every one of the four call sites must now destructure `outcome`, so no caller can
silently keep the old happy path. This follows `updateMemberRole`'s
`'ok' | 'not_member' | 'last_owner'` precedent — typed returns over thrown control flow.

The quota check runs **inside** the transaction, before the execution insert, and takes
the counter row's lock explicitly. `FOR UPDATE` alone is not enough — it locks nothing
when the row does not exist yet, which is precisely the first request of every new
period. The protocol is three statements, in this order:

```sql
INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
  VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING;                    -- ensure the row exists
SELECT quantity FROM workspace_usage_counters
  WHERE workspace_id=$1 AND period_start=$2 AND metric=$3 FOR UPDATE;   -- serialize
-- compare against the limit here; on block, return quota_exceeded and skip the update
UPDATE workspace_usage_counters SET quantity = quantity + 1
  WHERE workspace_id=$1 AND period_start=$2 AND metric=$3;
```

Every concurrent creation for the same workspace and period contends on that one row, so
the check and the increment are atomic with respect to each other and with the execution
insert. Returning `quota_exceeded` leaves the row at its existing value: the `INSERT …
DO NOTHING` only ever materialises a zero, and the `UPDATE` is skipped.

### Per-site behaviour

| Site | On block |
|---|---|
| `POST /v1/workflows/:id/execute` | 402 `Quota exceeded`, detail names metric, used, limit, and period reset |
| `POST /v1/executions/:id/retry` | same 402 |
| Gateway `POST /t/:routeKey` | **429** with a generic detail — an unauthenticated webhook caller must not learn the workspace's plan state |
| Scheduler cron fire | skip the fire, structured warn log; the managed quota alert notifies |
| `POST /v1/workflows/:id/activate` | 402 when `activeWorkflows` is at limit |
| `POST /v1/workspaces/invites` | 402 when `members` is at limit |
| `POST /v1/ai/generate`, `/v1/ai/edit` | 402 when `aiTokensPerMonth` is at limit |

Duplicate (idempotent) requests do **not** consume quota: the existing
`ON CONFLICT DO NOTHING` path returns `duplicate` before the counter is touched.

`allowOverage = true` turns every `blocked` into `warn`, so work proceeds and the counter
keeps climbing. Overage is derivable as `max(0, used - limit)`; O turns that into money.

## Soft limit reuses Phase 2J

`alert_events.rule_id` is `NOT NULL` with an FK to `alert_rules`, so a quota warning
needs a rule row. Each workspace gets one **managed** rule (`type = 'quota'`,
`managed = true`) created with the workspace and backfilled by 0010. The scheduler's
existing `runAlertSweep` gains a `quota` evaluator beside `failure_rate` and
`usage_threshold`: it loads the plan, computes the lines, and fires when any line is
`warn` or `blocked`, with the offending metric in `detail`.

This inherits cooldown, acknowledgement, signed webhook delivery, and the incident banner
without new machinery. `DELETE /v1/alerts/:id` refuses a managed rule with 409; `PUT`
still allows `enabled` and `cooldownMinutes` so a workspace can silence it.

## API

| Route | Permission | Body / response |
|---|---|---|
| `GET /v1/plan` | `billing:read` | `{ planCode, limits, usage, lines: QuotaLine[], allowOverage, period: { start, end } }` |
| `PUT /v1/plan` | `billing:manage` | `{ planCode?, allowOverage? }` → the same shape |

These are the routes M's permission catalog declared and left unrouted; the `UNROUTED`
allowlist in `apps/api/test/rbac.test.ts` drops to an empty array, and the matrix gains a
row for each.

`PUT /v1/plan` refuses a downgrade that the workspace already exceeds (409, naming the
metric), so a plan change cannot strand a workspace above a stock limit it cannot reduce
automatically.

## Web

- `/plan` page (Billing nav item): plan card, a meter per limit coloured by status, the
  overage toggle, and a plan switcher. `billing:read` gates the read; the controls render
  disabled without `billing:manage`. A 403 renders `PermissionNotice`, per M's convention.
- A quota banner in the app shell when any line is `warn` or `blocked`, reusing the
  existing incident-banner pattern.
- `forbiddenDetail` handling on every new query, so a refused read never renders as an
  empty state.

## Error handling

- Quota refusal is a first-class outcome, never an exception; the only throw path is a
  genuine DB failure, which keeps the existing 500 behaviour.
- A missing `workspace_plans` row is treated as the `free` plan, not as unlimited.
- The scheduler's quota skip is logged with workspace and metric but never aborts the
  sweep — one blocked workspace must not stall the tick for every other one. It follows
  the savepoint-per-rule pattern `runAlertSweep` already uses.
- 402 problem details name the metric, usage, limit, and reset date — enough for a user
  to act, with no secret or cross-tenant data.

## Testing

- **Pure (`packages/plans`):** `evaluateQuota` boundaries — under, exactly at soft
  threshold, exactly at limit, over, `null` unlimited, and overage flipping blocked→warn.
- **DB:** counter UPSERT accumulates; `recomputeCounters` reproduces the ledger exactly;
  `getWorkspacePlan` defaults to free with no row; gauges count only the right workspace.
- **Concurrency (the M lesson):** fire N parallel executions at a limit of N-1 and assert
  exactly N-1 are created and the counter never exceeds the limit. Written with
  `Promise.all` over a pre-warmed pool — a sequential version of this test passes against
  a broken guard and proves nothing.
- **API:** a 402 at each of the seven enforcement sites; duplicate requests do not consume
  quota; `PUT /v1/plan` downgrade conflict; rbac matrix rows for both billing permissions.
- **E2E:** a free-plan workspace runs to its execution cap, gets 402, an admin enables
  overage, and the next execution succeeds.
- **Web:** `/plan` renders meters and a 403 notice; api client matrix rows.

Coverage stays ≥80% on every package, as everywhere else.
