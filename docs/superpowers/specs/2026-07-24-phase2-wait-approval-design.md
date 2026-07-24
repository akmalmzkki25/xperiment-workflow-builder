# Phase 2 Sub-project F: Durable Wait & Human Approval — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (Phase 0 + all Phase 1 A–E merged); branch `feature/phase2-wait-approval`
**PRD requirements covered:** LOGIC-005 (wait stores state without holding a worker),
LOGIC-006 (approval has expiry, fallback, audit), EXE-008 (wait/resume + external
callback), UC-06 (human approval). Roadmap Phase 2 items: wait/resume, human approval.
**Non-goals (deferred):** signed external approve-links and embedding resume URLs into
outgoing messages (lands with the WhatsApp vertical pack, sub-projects G/L); exposing
the resume URL to *earlier* nodes via the expression context; saga/compensation
(LOGIC-007); rescheduling a fresh global watchdog after resume.

---

## 1. Goal

An execution can suspend at a node — for a fixed delay, until an external callback, or
until a human approves — **without holding a worker**, and resume durably (surviving a
restart). Human approval carries expiry, a fallback decision, and an audit trail.

## 2. Architecture at a glance

Suspension reuses the existing state machine almost unchanged: a wait node transitions
`RUNNING → WAITING` (new node status) and the worker returns immediately. `WAITING` is
neither `SUCCEEDED`/`SKIPPED`/`FAILED`, so `computeReadiness` already treats the branch
as undecided — no forward nodes queue and the execution stays `RUNNING` but makes no
progress. A single `resolveWait()` transitions `WAITING → SUCCEEDED` (or `FAILED`),
writes the node output + output port, and inserts a `node.completed` outbox event, so the
orchestrator's existing `SUCCEEDED → readiness` path advances the workflow with no change.
Three callers invoke `resolveWait()`: the approvals API, the gateway event endpoint, and a
new scheduler sweep for timers/expiry.

## 3. Data model (migration 0005_waits.sql)

- Node status `WAITING` added to `@xperiment/engine-core` states + transitions:
  `RUNNING → WAITING`, and `WAITING → SUCCEEDED | FAILED | SKIPPED`.
- `execution_waits` table:
  `id uuid pk, execution_id uuid, node_id text, attempt int, workspace_id uuid,
   kind text ('timer'|'event'|'approval'), resume_token text null unique,
   resume_at timestamptz null, expires_at timestamptz null,
   fallback text null ('approve'|'reject'|'fail'),
   message text null, status text ('open'|'resolved'|'expired') default 'open',
   decision text null, resolved_by uuid null, comment text null,
   created_at, resolved_at timestamptz null`.
  Indexes: `(status, resume_at)` and `(status, expires_at)` for the sweep;
  `(workspace_id, status)` for the pending list; unique `resume_token`.
  `workspace_id` inherited from the execution row via SQL subselect (tenant scoping).

## 4. Wait node connectors (`@xperiment/connectors`)

The connector `run()` returns a **suspend signal** instead of output. `NodeRunResult`
gains an optional `suspend?: SuspendSpec`; when present the worker suspends. Specs use
**relative** durations so connectors stay clock-free (the worker computes absolute times):

- `core.delay` — params `{ durationMs: int 1..(30 days) }` → `{ suspend: { kind: 'timer', delayMs } }`. Output on resume `{ waited: true }`, port `main`. Effect `pure`.
- `core.waitForEvent` — params `{ timeoutMs?: int }` → `{ suspend: { kind: 'event', ttlMs? } }`. Resume output = the callback JSON body, port `main`. Effect `pure`. Output ports `['main']`.
- `core.approval` — params `{ message: string, ttlMs: int, fallback: 'approve'|'reject'|'fail' }` → `{ suspend: { kind: 'approval', ttlMs, fallback, message } }`. Output ports `['approved','rejected']` (IF-like). Resume output `{ decision, comment, resolvedBy, resolvedAt }`, port = `approved`|`rejected`. Effect `pure`.

All three are `kind: 'logic'`, no connection required, registered in the default registry
(so the connector catalog + AI + canvas pick them up automatically).

## 5. Suspend + resume mechanics

**Suspend (worker, one tx):** on a `suspend` result, CAS the node `RUNNING → WAITING`,
insert an `execution_waits` row (`resume_at = now + delayMs` for timer; `expires_at =
now + ttlMs` and a 24-byte base64url `resume_token` for event/approval), append a
`node.waiting` event. No `node.completed` is emitted (suspension is not a completion).

**resolveWait (`@xperiment/db`, shared, one tx):**
`resolveWait(client, { waitId, output, outputPort, decision?, resolvedBy?, comment? })`
— CAS the `execution_waits` row `open → resolved` (no-op if already resolved: idempotent),
CAS the node `WAITING → SUCCEEDED` writing `output_json`/`output_port`, append
`node.resumed` event, insert a `node.completed` outbox `{ status: 'SUCCEEDED', outputPort }`.
For an approval-`fail` expiry it instead CAS's the node `WAITING → FAILED` and emits a
`node.completed` `{ status: 'FAILED' }`.

**Three callers:**
1. **Approvals API** — resolves an `approval` wait from an authenticated decision.
2. **Gateway `/r/:resumeToken`** — resolves an `event` wait with the request body.
3. **Scheduler `dueWaits` sweep** — `FOR UPDATE SKIP LOCKED` over waits where
   `status='open' AND (resume_at <= now OR expires_at <= now)`: timers resume with their
   default output; approval expiry applies `fallback` (approve/reject → resume on that
   port; fail → node FAILED); marks `status='expired'` on the expiry branch.

## 6. Watchdog interaction

`handleWatchdog` gains a guard: if the execution has any `open` `execution_waits` row (or
any `WAITING` node), it returns without timing out — a legitimately-waiting execution is
not stalled. Each wait's own `expires_at` (swept by the scheduler) bounds it instead.
`WAITING` is also removed from the watchdog's "fail these live nodes" set.

## 7. API + gateway surface

- `POST /v1/executions/:id/approvals/:nodeId` — builder role, workspace-scoped; body
  `{ decision: 'approve'|'reject', comment? }`; resolves the open approval wait for that
  node via `resolveWait`; 404 if none open, 409 if already resolved, 403 cross-tenant.
- `GET /v1/approvals?status=open&limit=` — workspace-scoped list:
  `{ items: [{ waitId, executionId, workflowId, nodeId, message, expiresAt, createdAt }] }`.
- Gateway `POST /r/:resumeToken` — no auth (token is the secret, like `/t/:routeKey`);
  resolves the matching open `event` wait with the JSON body; 404 unknown/closed;
  1 MB body limit; returns `{ resumed: true }`.
- `GET /v1/executions/:id` gains `waits: [{ nodeId, kind, status, resumeUrl?, expiresAt?,
  decision?, resolvedBy? }]` — `resumeUrl` = `${gatewayUrl}/r/{token}` for open `event`
  waits (this is where an operator/external system discovers the callback URL).

## 8. Web

- **Pending approvals page** `/approvals`: TanStack Query list of open approvals; each row
  → Approve / Reject buttons + optional comment; on decision, invalidate and refetch.
  Sidebar nav item. `data-testid`: `approvals-row-{nodeId}`, `approve-{nodeId}`,
  `reject-{nodeId}`, `approval-comment`.
- **Timeline**: `statusMeta('WAITING')` → `⏸` amber "Waiting"; a `WAITING` approval node
  links to `/approvals`.
- api client: `listApprovals()`, `decideApproval(execId, nodeId, decision, comment?)`.

## 9. Testing

- **engine-core:** `WAITING` in states/transitions; `computeReadiness` with a `WAITING`
  node yields no ready/terminal (branch paused); a pure `approvalFallbackOutcome(fallback)`
  helper (approve→port approved, reject→port rejected, fail→FAILED).
- **connectors:** the three nodes' param schemas + suspend specs (unit, no network);
  catalog includes them.
- **db:** `openWait`, `resolveWait` (idempotent, CAS), `dueWaits` sweep, `listOpenApprovals`
  — against real Postgres; secret-free.
- **worker:** suspend path — a delay node run leaves the node `WAITING` + one open wait row
  and emits no `node.completed`.
- **orchestrator:** watchdog skips an execution with an open wait (no `TIMED_OUT`).
- **scheduler:** `dueWaits` resumes a due timer and applies approval-expiry fallback.
- **api:** approve advances the run; reject takes the `rejected` port; expiry fallback via
  the sweep; auth + cross-tenant isolation; pending list scoped to workspace.
- **gateway:** `/r/:token` resumes an event wait; unknown token → 404.
- **e2e:** build a workflow `webhook → approval → transform`, run it, assert it sits
  `WAITING`, approve from the panel, assert the run reaches `SUCCEEDED`; plus a `core.delay`
  workflow that the scheduler timer resumes.
- Coverage ≥80% on all touched packages; both e2e suites green.

## 10. Risks

| Risk | Mitigation |
|---|---|
| A resumed execution runs with no fresh global watchdog | Each wait bounds itself via `expires_at`; documented; watchdog reschedule is a follow-on |
| Double-resume (timer sweep races an API decision) | `resolveWait` CAS's `open → resolved` and the node `WAITING → SUCCEEDED`; the loser is a no-op |
| Unbounded wait duration | `durationMs`/`ttlMs` capped (≤30 days) in the param schemas; sweep enforces `expires_at` |
| Resume token guessing (event) | 24-byte base64url token, unique, single-use (closed on resolve), timing-safe lookup by exact token |
| WAITING node timed out by watchdog | Watchdog guard skips open-wait executions and excludes `WAITING` from the fail set |
