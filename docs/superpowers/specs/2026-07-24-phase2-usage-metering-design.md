# Phase 2 Sub-project I — Usage Metering — Design

**Status:** Approved (design gate 2026-07-24)
**Requirements:** PRD BILL-001 (append-only usage ledger), BILL-002 (near-real-time usage view). Related surfaces: MON-006 (dashboard runs/credits/AI cost), EXE-015 (per-node usage metrics — partially).
**Out of scope (later slices):** BILL-003 soft/hard limits + overage, BILL-004 plan entitlement, BILL-005 invoicing/payment, BILL-006 per-workflow cost attribution report, BILL-007 BYOK accounting, BILL-008 committed usage. Metering dimensions not derivable today (storage, concurrency, premium-connector, active-workflow, embedded end-customer).

## Goal

Record every billable unit of work an execution consumes into an append-only ledger, exactly once, at the moment the execution finalizes; and expose a tenant-scoped, real-time usage view (API + web page) aggregating that ledger.

## Metering dimensions (this slice)

Four metrics, all integer quantities:

| metric | quantity unit | emitted when | source |
|---|---|---|---|
| `execution` | count (always 1) | execution reaches a terminal state | finalization tx; `metadata.status` ∈ SUCCEEDED/FAILED/TIMED_OUT/CANCELED |
| `node` | count (nodes that ran) | same terminal tx | count of that execution's nodes in a terminal-run state |
| `compute_ms` | milliseconds | same terminal tx | `finalizedAt − started_at` (0 if never started) |
| `ai_tokens` | tokens | a `/v1/ai/*` call succeeds | OpenRouter `usage.total_tokens`, summed across repair attempts |

"Successful vs failed vs billable execution" (PRD dimensions) are all derived from the `execution` rows' `metadata.status` — no separate metrics.

## Architecture

**Transactional ledger at finalization.** Execution-derived usage rows are inserted inside the *same* CAS-guarded `withTx` that flips the execution to a terminal status — the exact point where `enqueueCompletionCallback` already fires. Because that branch is reached only by the single CAS winner (`if (done)` / `if (failed)` / `if (timedOut)` / `if (canceled)`), a redelivered `node.completed` job (BullMQ at-least-once) cannot double-count. This makes the ledger exactly-once by construction with no separate consumer and no eventual-consistency lag: the "near-real-time" view (BILL-002) is a live aggregate.

Rejected alternatives: **derive-on-read** (no ledger, aggregate `executions`/`execution_nodes`) fails BILL-001's explicit append-only ledger and cannot hold AI tokens or frozen rates; **async `usage.record` outbox + consumer** adds a moving part and lag for no benefit, since emission already happens inside a DB transaction.

**Why in-tx is safe, not a liability:** `usage_events` has no unique/business constraints — an insert cannot conflict. Its only realistic failure is DB-unavailability, which already aborts the whole finalize transaction regardless of metering. So co-locating the insert with finalization adds no new failure mode, and `withTx`'s deadlock/serialization retry covers transient aborts.

**AI tokens are best-effort.** The `/v1/ai/*` routes have no finalize transaction. They record one `ai_tokens` row after a successful generation; a failure to record is logged and swallowed so a metering write never fails the user's generation (the generated workflow is the user's primary value). Losing an occasional AI-token row is acceptable for beta; losing an execution row is not — hence the asymmetry.

## Components

### packages/db

- **Migration `0007_usage.sql`:**
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
- **`repos/usage.ts`** (append-only surface — insert + read only, no update/delete exported):
  - `type UsageMetric = 'execution' | 'node' | 'compute_ms' | 'ai_tokens'`
  - `interface UsageEventInput { workspaceId; metric; quantity; executionId?; workflowId?; metadata?; occurredAt }`
  - `insertUsageEvents(client: Db, events: UsageEventInput[]): Promise<void>` — single multi-row INSERT; no-op on empty array.
  - `recordExecutionUsage(client, args: { workspaceId; workflowId; executionId; status; nodeCount; computeMs; occurredAt })` — builds the three rows (`execution` qty 1 + `metadata.status`, `node` qty `nodeCount`, `compute_ms` qty `computeMs`) and calls `insertUsageEvents`. Emits the `node`/`compute_ms` rows only when their quantity > 0 (avoid noise rows for a run that never started).
  - `recordAiUsage(db: Db, args: { workspaceId; tokens; model; kind })` — inserts one `ai_tokens` row (`metadata { model, kind }`, `occurredAt = now`). Skips the insert when `tokens <= 0`.
  - `getUsageSummary(db: Db, args: { workspaceId; from: Date; to: Date }): Promise<UsageSummary>` where
    ```ts
    interface UsageSummary {
      period: { from: string; to: string };
      totals: { executions; succeeded; failed; nodes; computeMs; aiTokens };
      series: { date: string; executions; nodes; computeMs; aiTokens }[]; // daily, UTC
    }
    ```
    Implemented as two grouped queries (totals via `SUM(...) FILTER (WHERE ...)`; series via `date_trunc('day', occurred_at)` grouping), scoped by `workspace_id` and `occurred_at ∈ [from, to)`.

### packages/engine-core

- No new status. `computeMs`/`nodeCount` are computed by callers from existing data.

### apps/orchestrator

- **`handlers/nodeCompleted.ts`:** in the direct-FAILED branch (`if (failed)`), the SUCCEEDED-terminal branch (`if (done)`), and the readiness-FAILED terminal branch (`if (done)` after `to:'FAILED'`), after `enqueueCompletionCallback`, call `recordExecutionUsage(client, …)`. `nodeCount` = `states.filter(s => s.status === 'SUCCEEDED' || s.status === 'FAILED').length` computed from the `latestNodeStates` already loaded in-tx; `computeMs` = `Date.now() − ctx.execution.startedAt` (0 when `startedAt` is null); `status` matches the terminal status just set; `occurredAt = new Date()`.
- **`handlers/watchdog.ts`:** in the `if (timedOut)` branch, after `enqueueCompletionCallback`, call `recordExecutionUsage` with `status:'TIMED_OUT'`.
- Node count for watchdog/cancel counts nodes that reached SUCCEEDED/FAILED before termination.

### apps/api

- **`routes/executions.ts` cancel path:** in the `if (canceled)` block (after `enqueueCompletionCallback`), call `recordExecutionUsage` with `status:'CANCELED'`, using the node states already loaded (`nodeCount` = states in SUCCEEDED/FAILED) and `computeMs` from `detail.execution.startedAt`.
- **`routes/usage.ts` (new):** `GET /v1/usage` — query `from`/`to` (ISO dates, optional; default `from` = first day of current UTC month, `to` = now). Zod-validated. `viewer`+ (any authenticated member). Scopes to `authOf(req).workspaceId`. Returns `getUsageSummary(...)`.
- Registered in `server.ts` alongside the other route groups; auth applies (not exempt), rate limit applies.

### packages/ai

- The OpenRouter client's response parsing surfaces `usage` → `{ promptTokens, completionTokens, totalTokens }`. `generate` and `edit` accumulate `totalTokens` across all attempts (initial + repair loop) and include `tokensUsed: number` in their return value.
- `/v1/ai/generate` and `/v1/ai/edit` routes call `recordAiUsage(deps.pool, { workspaceId, tokens: result.tokensUsed, model, kind: 'generate'|'edit' })` in a try/catch that logs and swallows failures.

### apps/web

- **`/usage` page:** fetches `getUsage()`, renders Arus scorecards (Runs, Success rate, Nodes, Compute (formatted), AI tokens) and a daily bar chart of runs (lightweight inline SVG/CSS bars — no new chart dependency). Date-range defaults to current month; a simple range selector may be added but is optional.
- **`lib/api.ts`:** `getUsage(params?: { from?; to? }): Promise<UsageSummary>` + the `UsageSummary` type.
- Nav: add a "Usage" link in the app shell.

## Data flow

```
execution finalizes (orchestrator/watchdog/cancel)
  └─ withTx (CAS single-winner)
       casExecution → terminal          ← guarded
       enqueueCompletionCallback         ← existing
       recordExecutionUsage → usage_events (execution, node, compute_ms)   ← NEW
AI generate/edit
  └─ OpenRouter call(s) → tokensUsed
       recordAiUsage → usage_events (ai_tokens)   ← NEW, best-effort
GET /v1/usage → getUsageSummary → aggregate over usage_events (tenant-scoped)
```

## Error handling

- Execution usage insert: in-tx, constraint-free; a failure aborts the finalize tx (same as any DB outage) and is retried by `withTx`. No new partial-state risk.
- AI usage insert: best-effort; log `usage.ai_record_failed` and continue.
- `GET /v1/usage`: invalid `from`/`to` → 400 problem; `from > to` → 400. Empty ledger → zeroed totals + empty series (200).
- Tenant isolation: every query filters by `workspace_id` from the auth context; a cross-workspace `execution_id` is never returned (aggregates only).

## Testing

- **db (`test/usage.test.ts`):** insert rows; `getUsageSummary` totals + status breakdown + daily series bucketing; empty-period returns zeros; `recordExecutionUsage` omits zero-quantity node/compute rows; `recordAiUsage` skips zero tokens.
- **orchestrator (`test/nodeCompleted.test.ts`, `test/watchdog.test.ts`):** SUCCEEDED/FAILED/TIMED_OUT each write the expected `execution`+`node`+`compute_ms` rows with correct status; a duplicate `node.completed` (second delivery) does NOT add a second `execution` row (CAS guard).
- **api (`test/usage.test.ts`):** `GET /v1/usage` returns tenant totals; cross-workspace isolation (another workspace's runs excluded); default period; 400 on bad range.
- **ai (`test/*`):** client parses `usage` and returns `tokensUsed`; a stubbed generate records one `ai_tokens` row; a failing insert does not fail generation.
- **web:** `getUsage` client method (api.test matrix); usage-page data mapping if a lib helper is extracted.
- **e2e (`e2e/test/acceptance.test.ts`):** run a workflow to completion, then `GET /v1/usage` shows `executions ≥ 1`, `nodes ≥ 1`, `computeMs ≥ 0`.

Gates before merge: all package suites green, coverage ≥80% (statements/branches/functions/lines) every package, root `typecheck` clean, `@xperiment/e2e` + `@xperiment/web e2e` green, then adversarial multi-agent review, fix confirmed findings, fast-forward merge `feature/phase2-usage-metering` → master.

## File layout

```
packages/db/src/migrations/0007_usage.sql          (new)
packages/db/src/repos/usage.ts                      (new)
packages/db/src/index.ts                            (export usage repo)
packages/db/test/usage.test.ts                      (new)
packages/ai/src/*                                   (surface usage tokens)
apps/orchestrator/src/handlers/nodeCompleted.ts     (emit usage)
apps/orchestrator/src/handlers/watchdog.ts          (emit usage)
apps/api/src/routes/executions.ts                   (emit usage on cancel)
apps/api/src/routes/usage.ts                        (new: GET /v1/usage)
apps/api/src/server.ts                              (register route)
apps/api/test/usage.test.ts                         (new)
apps/web/src/app/(app)/usage/page.tsx               (new)
apps/web/src/lib/api.ts                             (getUsage + type)
apps/web/src/app/(app)/…/nav                        (Usage link)
e2e/test/acceptance.test.ts                         (usage assertion)
README.md                                           (Usage metering section)
```
