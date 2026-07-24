# Phase 2 Sub-project F: Durable Wait & Human Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution — the user's standing choice). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Suspend an execution at a node (delay, external event, or human approval) without holding a worker, and resume durably; approvals carry expiry, fallback, and audit.

**Architecture:** New node status `WAITING` + an `execution_waits` table. A wait connector returns a `suspend` signal; the worker CAS's `RUNNING→WAITING` and records a wait row. One shared `resolveWait()` CAS's `WAITING→SUCCEEDED` and emits `node.completed`, so the orchestrator's existing readiness path advances the run. Three callers of `resolveWait`: approvals API, gateway `/r/:token`, scheduler `dueWaits` sweep. Watchdog skips executions with an open wait.

**Tech Stack:** tsx-run TS, Postgres/pg, BullMQ outbox, Fastify, Next.js/React, vitest (80%).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-phase2-wait-approval-design.md`.
- Conventional commits, no attribution trailer. No console.log in production code. No hardcoded secrets. Immutable updates. CAS state machine (reuse `casNode`/`casExecution` patterns).
- `computeReadiness` treats `WAITING` as undecided already — do not special-case it there beyond the transition tables.
- Suspend specs use RELATIVE durations (`delayMs`/`ttlMs`); the worker computes absolute `resume_at`/`expires_at` (connectors stay clock-free).
- `resolveWait` is idempotent (CAS `open→resolved`); double-resume loser is a no-op.
- Duration caps: `durationMs`/`ttlMs` integer 1..2_592_000_000 (30 days).
- `resume_token`: 24-byte base64url, unique, single-use, timing-safe exact-match lookup.
- Tenant scoping: `execution_waits.workspace_id` inherited from the execution via SQL subselect; API list/decision scoped by workspace; gateway `/r/:token` needs no auth (token is the secret).
- Coverage ≥80% (lines/statements/functions/branches) on all touched packages; `pnpm typecheck` clean; both e2e suites green.

## File Structure

```
packages/engine-core/src/states.ts, transitions.ts   modify: WAITING
packages/engine-core/src/waits.ts                     create: approvalFallbackOutcome
packages/db/src/migrations/0005_waits.sql             create
packages/db/src/repos/waits.ts                        create: openWait/resolveWait/dueWaits/listOpenApprovals/waitsForExecution
packages/db/src/repos/executions.ts                   modify: getExecutionDetail → waits
packages/connectors/src/types.ts                      modify: NodeRunResult.suspend
packages/connectors/src/core/{delay,waitForEvent,approval}.ts  create
packages/connectors/src/registry.ts                   modify: register the three
apps/worker/src/runTask.ts                            modify: suspend path
apps/orchestrator/src/handlers/watchdog.ts            modify: open-wait guard
apps/scheduler/src/waitSweep.ts                       create: dueWaits sweep
apps/scheduler/src/main.ts                            modify: run the sweep each tick
apps/api/src/routes/approvals.ts                      create
apps/api/src/routes/executions.ts                     modify: detail waits passthrough (already returns getExecutionDetail)
apps/gateway/src/server.ts                            modify: POST /r/:resumeToken
apps/web/src/app/(app)/approvals/page.tsx             create
apps/web/src/lib/api.ts, statusMeta.ts, Sidebar.tsx   modify
e2e/test/, apps/web/e2e/                              modify: wait/approval flows
.env.example, README.md                               modify
```

---

### Task F-1: engine-core WAITING status + fallback helper

**Files:**
- Modify: `packages/engine-core/src/states.ts` (add `'WAITING'` to `NODE_STATUSES`), `transitions.ts` (`RUNNING: [..., 'WAITING']`; `WAITING: ['SUCCEEDED','FAILED','SKIPPED']`)
- Create: `packages/engine-core/src/waits.ts`; export from `src/index.ts`
- Test: `packages/engine-core/test/waits.test.ts`, extend `readiness.test.ts`

**Interfaces:**
```ts
// waits.ts
export type ApprovalFallback = 'approve' | 'reject' | 'fail';
export interface FallbackOutcome { terminal: 'SUCCEEDED' | 'FAILED'; outputPort?: 'approved' | 'rejected' }
export function approvalFallbackOutcome(fallback: ApprovalFallback): FallbackOutcome
// approve→{terminal:'SUCCEEDED',outputPort:'approved'}, reject→{...'rejected'}, fail→{terminal:'FAILED'}
```

- [ ] Failing tests: `canTransitionNode('RUNNING','WAITING')` true; `WAITING→SUCCEEDED` true, `WAITING→QUEUED` false; `approvalFallbackOutcome` maps all three; `computeReadiness` with a node `WAITING` returns `ready:[]`, `terminal:null` and its downstream stays unready.
- [ ] Run → FAIL → implement → PASS; coverage ≥80%.
- [ ] Commit `feat: add WAITING node status and approval fallback helper`.

### Task F-2: migration 0005 + execution_waits repo + detail waits

**Files:**
- Create: `packages/db/src/migrations/0005_waits.sql` (table per spec §3 + indexes)
- Create: `packages/db/src/repos/waits.ts`; export from `packages/db/src/index.ts`
- Modify: `packages/db/src/repos/executions.ts` `getExecutionDetail` to also select waits
- Test: `packages/db/test/waits.test.ts`

**Interfaces (produced):**
```ts
export interface WaitRow { id; executionId; nodeId; attempt; kind:'timer'|'event'|'approval'; resumeToken:string|null; resumeAt:string|null; expiresAt:string|null; fallback:string|null; message:string|null; status:'open'|'resolved'|'expired'; decision:string|null; resolvedBy:string|null; comment:string|null }
export async function openWait(db, args:{ executionId; nodeId; attempt; kind; resumeToken?; resumeAt?:Date; expiresAt?:Date; fallback?; message? }): Promise<WaitRow> // workspace_id via subselect
export async function resolveWait(client, args:{ waitId; status?:'resolved'|'expired'; decision?; resolvedBy?; comment? }): Promise<boolean> // CAS open→status; returns false if already closed
export async function getOpenWaitByToken(db, token:string): Promise<WaitRow|null>
export async function getOpenApprovalWait(db, args:{ executionId; nodeId; workspaceId }): Promise<WaitRow|null>
export async function listOpenApprovals(db, args:{ workspaceId; limit }): Promise<{ waitId; executionId; workflowId; nodeId; message; expiresAt; createdAt }[]>
export async function dueWaits(client, limit:number): Promise<WaitRow[]> // FOR UPDATE SKIP LOCKED where status='open' and (resume_at<=now or expires_at<=now)
export async function waitsForExecution(db, executionId): Promise<WaitRow[]>
```
- `getExecutionDetail` return gains `waits: WaitRow[]`.

- [ ] Failing tests (real Postgres, TRUNCATE in beforeEach): openWait inserts with inherited workspace_id; resolveWait CAS `open→resolved` returns true once then false; getOpenWaitByToken finds only open; listOpenApprovals scoped to workspace + only approval+open; dueWaits returns rows past resume_at/expires_at and skips future ones.
- [ ] Run → FAIL → implement (mirror `triggers.ts` SKIP LOCKED + subselect patterns) → PASS; coverage ≥80% (add a `waits`-focused coverage test if branches lag).
- [ ] Commit `feat: add execution_waits schema and repository`.

### Task F-3: wait connectors + suspend result

**Files:**
- Modify: `packages/connectors/src/types.ts` (`NodeRunResult` gains `suspend?: SuspendSpec`; export `SuspendSpec`)
- Create: `packages/connectors/src/core/delay.ts`, `core/waitForEvent.ts`, `core/approval.ts`; export from index; register in `registry.ts`
- Test: `packages/connectors/test/waitNodes.test.ts`; extend `catalog.test.ts` count

**Interfaces:**
```ts
// types.ts
export type SuspendSpec =
  | { kind: 'timer'; delayMs: number }
  | { kind: 'event'; ttlMs?: number }
  | { kind: 'approval'; ttlMs: number; fallback: 'approve'|'reject'|'fail'; message: string };
export interface NodeRunResult { output?: unknown; outputPort?: string; suspend?: SuspendSpec }
// delay: params { durationMs:int 1..2_592_000_000 } → { suspend:{kind:'timer',delayMs:durationMs} }; outputPorts ['main']
// waitForEvent: params { timeoutMs?:int } → { suspend:{kind:'event', ttlMs?:timeoutMs} }; outputPorts ['main']
// approval: params { message:string.min1, ttlMs:int 1..2_592_000_000, fallback enum } → { suspend:{kind:'approval',ttlMs,fallback,message} }; outputPorts ['approved','rejected']
```
- All `kind:'logic'`, `defaultEffectClass:'pure'`, no `requiresConnection`.

- [ ] Failing tests: each node's `run()` returns the expected `suspend` spec for valid params and throws `NodeRunError('invalid_parameters')` on bad params; `core.approval.outputPorts` = `['approved','rejected']`; catalog now lists 13 connectors and includes `core.approval` with those ports.
- [ ] Run → FAIL → implement → PASS; coverage ≥80%.
- [ ] Commit `feat: add delay, waitForEvent, and approval wait nodes`.

### Task F-4: worker suspend path

**Files:**
- Modify: `apps/worker/src/runTask.ts` (handle `result.suspend`)
- Test: `apps/worker/test/suspend.test.ts`

**Behavior:** after `executeNode`, if `result.suspend` is set, in one tx:
CAS node `RUNNING→WAITING` (patch `inputJson: resolvedParams`); if not written, return.
Compute absolute times from `Date.now()`: timer → `resumeAt = now+delayMs`; event/approval → `expiresAt = now+ttlMs`, `resumeToken = randomBytes(24).base64url`. `openWait(client, {...})`. `appendEvent 'node.waiting'`. Insert **no** `node.completed`. (If `result.suspend` unset, the existing SUCCEEDED path runs unchanged.)

- [ ] Failing test: run a `core.delay` node task → node latest status `WAITING`, exactly one open `execution_waits` row with `resume_at` in the future, and no `node.completed` row in `task_outbox`.
- [ ] Run → FAIL → implement → PASS. `pnpm --filter @xperiment/worker test` green.
- [ ] Commit `feat: suspend node execution on a wait signal`.

### Task F-5: watchdog guard + scheduler wait sweep

**Files:**
- Modify: `apps/orchestrator/src/handlers/watchdog.ts` (skip if any open wait; exclude `WAITING` from the fail set)
- Create: `apps/scheduler/src/waitSweep.ts`; call it from `apps/scheduler/src/main.ts` each tick
- Test: `apps/orchestrator/test/watchdogWait.test.ts`, `apps/scheduler/test/waitSweep.test.ts`

**Interfaces:**
```ts
// waitSweep.ts
export async function runWaitSweep(deps:{ pool; log }): Promise<{ resumed:number; expired:number }>
// withTx: dueWaits(client, BATCH); for each: timer → resolveWait(resolved) + node WAITING→SUCCEEDED(output {waited:true}, port main) + node.completed outbox;
//   event expiry → resolveWait(expired) + node WAITING→FAILED(error {code:'wait_timeout'}) + node.completed FAILED;
//   approval expiry → approvalFallbackOutcome(fallback): approved/rejected → resolved + WAITING→SUCCEEDED(output {decision:fallback,expired:true}, port) + node.completed SUCCEEDED; fail → expired + WAITING→FAILED + node.completed FAILED.
// Reuse a shared applyResume(client, wait, {terminal, outputPort, output, decision?}) helper to keep the three callers DRY.
```
- Watchdog: `const openWaits = await waitsForExecution(client, executionId); if (openWaits.some(w => w.status==='open')) return;` before the fail loop; and drop `WAITING` from `['PENDING','READY','QUEUED','RUNNING']`.

- [ ] Failing tests: watchdog on an execution whose node is `WAITING` (open wait row) leaves status `RUNNING` (not `TIMED_OUT`); waitSweep resumes a due timer (node→SUCCEEDED, wait→resolved, node.completed queued) and applies approval-expiry fallback `reject` (node→SUCCEEDED port `rejected`, wait→expired).
- [ ] Run → FAIL → implement → PASS.
- [ ] Commit `feat: add wait sweep and watchdog wait guard`.

### Task F-6: approvals API + gateway resume endpoint

**Files:**
- Create: `apps/api/src/routes/approvals.ts` (register in `server.ts`)
- Modify: `apps/api/src/routes/executions.ts` — `GET /v1/executions/:id` already returns `getExecutionDetail`, which now carries `waits`; add per-wait `resumeUrl` = `${gatewayUrl}/r/{token}` for open `event` waits (map before send, do NOT expose tokens for non-event or resolved waits)
- Modify: `apps/gateway/src/server.ts` — `POST /r/:resumeToken`
- Test: `apps/api/test/approvals.test.ts`, extend gateway test

**Interfaces:**
```ts
// approvals.ts (shared applyResume from a small module re-exported by @xperiment/db or a local helper)
POST /v1/executions/:id/approvals/:nodeId  builder role; body { decision:'approve'|'reject', comment?:string(max2000) }
  → getOpenApprovalWait(pool,{executionId:id,nodeId,workspaceId}); 404 if none;
    resolveWait+applyResume in a tx (output {decision,comment,resolvedBy:userId,resolvedAt}, port approved|rejected); 200 {resolved:true}
GET /v1/approvals?status=open&limit(1..100 def 20)  → { items: listOpenApprovals(pool,{workspaceId,limit}) }
// gateway
POST /r/:resumeToken (raw JSON, 1MB) → getOpenWaitByToken; 404 if none; kind must be 'event';
  applyResume(resolved, output=body, port 'main'); 200 { resumed:true }
```

- [ ] Failing tests (stub not needed; drive via a seeded WAITING wait row or a full run): approve advances — after approve, node `SUCCEEDED` port `approved`; reject → port `rejected`; second decision on the same wait → 409/404; cross-workspace decision → 404/403; pending list scoped to workspace; gateway `/r/:token` resumes an event wait and unknown token → 404.
- [ ] Run → FAIL → implement → PASS; `pnpm --filter @xperiment/api test` green.
- [ ] Commit `feat: add approvals API and gateway resume endpoint`.

### Task F-7: web approvals page + timeline + e2e + docs + merge

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`listApprovals`, `decideApproval`), `src/lib/statusMeta.ts` (`WAITING`→`⏸`/amber/"Waiting"), `src/components/shell/Sidebar.tsx` (Approvals nav)
- Create: `apps/web/src/app/(app)/approvals/page.tsx`
- Modify: e2e — add a wait connector-aware flow. Root `e2e/test/` gets an approval scenario; `apps/web/e2e/web.spec.ts` gets a browser approval flow (build `webhook→approval→transform`, run via webhook, see WAITING, approve on the panel, run SUCCEEDED). Scheduler `SCHEDULER_INTERVAL_MS` already low in e2e for the timer path.
- Modify: `.env.example` (none new expected), `README.md` (Wait & Approval section)

**Behavior:** approvals page lists open approvals (poll 5s), Approve/Reject with a comment box, invalidate on success. Timeline renders `WAITING` amber; an approval `WAITING` row links to `/approvals`.

- [ ] `pnpm --filter @xperiment/web typecheck` green; approvals page + timeline built.
- [ ] Full verification: `pnpm run test:cov` exit 0 (all ≥80%), `pnpm typecheck` exit 0, `pnpm --filter @xperiment/e2e test` green, `pnpm --filter @xperiment/web e2e` green.
- [ ] Commit `feat: add approvals page and wait timeline` then `docs: document wait and approval`.
- [ ] Adversarial review (security: token guessing, cross-tenant approval, resume auth; correctness: double-resume race, expiry fallback, readiness with WAITING, watchdog guard; TS; test-gaps). Fix confirmed findings; re-verify.
- [ ] Fast-forward merge `feature/phase2-wait-approval` → master; delete branch.

## Self-Review Notes

- One `applyResume` helper backs all three resume callers (API, gateway, sweep) — the CAS + node.completed emission lives in exactly one place.
- `WAITING` needs no readiness special-case: it is simply not `SUCCEEDED`/`SKIPPED`/`FAILED`, so downstream stays undecided and the execution stays non-terminal — verified against `computeReadiness`.
- The worker owns absolute time; connectors return relative durations, keeping them deterministic and clock-free.
- Idempotent `resolveWait` (`open→resolved` CAS) makes the timer-sweep-vs-API-decision race safe: the loser no-ops.
