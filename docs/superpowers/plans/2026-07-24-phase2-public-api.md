# Phase 2 Sub-project H: Public API Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cancel + retry executions, rate-limit headers, execution-completion webhooks, and a published OpenAPI document.

**Architecture:** A new terminal `CANCELED` status; cancel/retry as API routes reusing CAS + `closeOpenWaits` + `createExecutionWithTrigger`; a Fastify rate-limit plugin; a completion webhook delivered via the outbox → a new BullMQ queue → a worker consumer that SSRF-checks and HMAC-signs; a hand-authored `openapi.json`.

**Tech Stack:** tsx-run TS, Fastify, pg, BullMQ, Next.js, vitest (80%).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-phase2-public-api-design.md`.
- Conventional commits, no attribution trailer. No console.log. No hardcoded secrets. Immutable updates. CAS state machine.
- CANCELED joins every `TERMINAL_EXECUTION_STATUSES` list (worker/orchestrator) and the worker/orchestrator terminal guards.
- Callback URL is SSRF-checked with `assertUrlAllowed` (the `http.request` guard) before any POST; callback secret AES-GCM-encrypted, never logged, only an HMAC is sent.
- Rate limiter is in-memory/single-instance (documented). Coverage ≥80% touched packages; typecheck clean; both e2e suites green.

## File Structure

```
packages/engine-core/src/states.ts, transitions.ts   modify: CANCELED
packages/db/src/repos/executions.ts                   modify: cancelExecution helper; retry reads version+payload
packages/db/src/migrations/0006_callback.sql          create: workflows callback url+secret
packages/db/src/repos/workflows.ts                    modify: get/set/clear callback
packages/queue/src/names.ts, payloads.ts, publisher.ts modify: execution.callback queue + jobId
apps/api/src/routes/executions.ts                     modify: cancel + retry
apps/api/src/routes/workflows.ts                      modify: PUT/DELETE callback
apps/api/src/rateLimit/plugin.ts                      create
apps/api/src/openapi.ts + routes/openapi.ts           create
apps/api/src/server.ts                                modify: register rateLimit + openapi
apps/orchestrator/src/handlers/nodeCompleted.ts, watchdog.ts  modify: enqueue callback on terminal
apps/orchestrator/src/handlers/executionCanceled?  (cancel is API-driven; no orch handler)
apps/worker/src/callback.ts + main.ts                 create/modify: callback consumer
apps/web/src/lib/api.ts, statusMeta.ts, executions/[id]/page.tsx  modify: retry/cancel + CANCELED
e2e/test/, apps/web/e2e/                              modify: callback + cancel flows
README.md                                             modify
```

---

### Task H-1: CANCELED status + cancel + retry endpoints

**Files:**
- Modify: `packages/engine-core/src/states.ts` (`CANCELED`), `transitions.ts` (`RUNNING/QUEUED → CANCELED`), extend `transitions.test.ts`
- Modify: `apps/orchestrator/src/deps.ts` + `apps/worker/src/runTask.ts` terminal lists to include `CANCELED`
- Modify: `apps/api/src/routes/executions.ts` (cancel + retry)
- Test: `apps/api/test/executions.test.ts` (extend) or new `executionsControl.test.ts`

**Interfaces:**
```ts
POST /v1/executions/:id/cancel  builder; getExecutionDetail scoped; if terminal → 409 'already_terminal';
  withTx: casExecution QUEUED|RUNNING → CANCELED (completedAt, errorSummary 'Canceled');
  for each latest node in [PENDING,READY,QUEUED,RUNNING,WAITING]: casNode → SKIPPED;
  closeOpenWaits(client, id); appendEvent 'execution.canceled'; 200 { status:'CANCELED' }
POST /v1/executions/:id/retry  builder; load exec (workspace-scoped) → workflowVersionId + trigger payload
  (getTriggerPayload); idempotencyKey = header 'idempotency-key' ?? randomUUID();
  createExecutionWithTrigger({ workflowId, versionId, idempotencyKey, payload, nodeIds: ir.nodes, executionTimeoutMs });
  201 { executionId, status, created }
```

- [ ] Failing tests: cancel a RUNNING execution → status CANCELED, its non-terminal nodes SKIPPED, open wait closed; cancel a terminal execution → 409; cross-tenant cancel → 404; retry creates a NEW execution id from the same version, and a repeated retry with the same Idempotency-Key returns the same new execution (created:false on the 2nd).
- [ ] Run → FAIL → implement → PASS; `pnpm --filter @xperiment/engine-core --filter @xperiment/api test` green.
- [ ] Commit `feat: add execution cancel and retry endpoints`.

### Task H-2: rate-limit headers plugin

**Files:**
- Create: `apps/api/src/rateLimit/plugin.ts`; register in `server.ts` (onRequest, after auth resolves the key/workspace)
- Test: `apps/api/test/rateLimit.test.ts`

**Interfaces:**
```ts
export function registerRateLimit(app, opts: { perMinute: number }): void
// onRequest (skip /v1/healthz, /v1/openapi.json, non-/v1): key = authOf(req).apiKeyId ?? workspaceId ?? req.ip;
//   fixed 60s window map key -> { count, resetAt }; set X-RateLimit-Limit/Remaining/Reset;
//   over limit → reply 429 + Retry-After + sendProblem 'rate_limited'
// server resolves perMinute from process.env RATE_LIMIT_PER_MIN ?? 600
```
- `AuthContext` may need an `apiKeyId` — if not present, key on `workspaceId`. (Check auth plugin; add apiKeyId to context if the api-key path has it.)

- [ ] Failing tests (build server with perMinute=2): first 2 requests carry `X-RateLimit-Remaining` decreasing and 200; 3rd → 429 with `Retry-After`; `/v1/healthz` and `/v1/openapi.json` are never limited.
- [ ] Run → FAIL → implement → PASS.
- [ ] Commit `feat: add rate-limit headers to the API`.

### Task H-3: completion webhook

**Files:**
- Create: `packages/db/src/migrations/0006_callback.sql` (`workflows.completion_webhook_url TEXT`, `completion_webhook_secret_encrypted BYTEA`)
- Modify: `packages/db/src/repos/workflows.ts` (`setWorkflowCallback`, `clearWorkflowCallback`, `getWorkflowCallback`)
- Modify: `apps/api/src/routes/workflows.ts` (`PUT`/`DELETE /v1/workflows/:id/callback`)
- Modify: `packages/queue/src/{names,payloads,publisher}.ts` (`execution.callback` queue + `jobIdFor` `callback_{executionId}`)
- Modify: `apps/orchestrator/src/handlers/nodeCompleted.ts` + `watchdog.ts` (on terminal, if callback set, insert `execution.callback` outbox)
- Create: `apps/worker/src/callback.ts` (`runCallback`); register a BullMQ worker in `apps/worker/src/main.ts`
- Test: `apps/api/test/callback.test.ts`, `apps/worker/test/callback.test.ts`, `apps/orchestrator/test/callbackEnqueue.test.ts`

**Interfaces:**
```ts
// workflows repo
setWorkflowCallback(db, { workflowId, url, secretEncrypted }): Promise<void>
clearWorkflowCallback(db, workflowId): Promise<void>
getWorkflowCallback(db, workflowId): Promise<{ url: string; secretEncrypted: Buffer } | null>
// API
PUT /v1/workflows/:id/callback { url: https url } builder → generate 24B secret, encryptSecret(triggerKey), store; 200 { url, secret } (shown once)
DELETE /v1/workflows/:id/callback → 204
// orchestrator: after casExecution to any terminal (SUCCEEDED/FAILED/TIMED_OUT), if getWorkflowCallback set → insertOutbox 'execution.callback' { executionId }
// worker callback.ts
runCallback(deps:{ pool; triggerKey; log }, payload:{ executionId }): load execution + workflow callback;
  assertUrlAllowed(url) (throws → drop, log 'callback.blocked'); POST {executionId,workflowId,status,completedAt}
  with header X-Xperiment-Signature 'sha256='+hmacSHA256(secret, rawBody); 10s timeout; non-2xx throws (BullMQ retries)
```

- [ ] Failing tests: callback API stores encrypted secret + returns it once; orchestrator terminal with callback set inserts one `execution.callback`; worker `runCallback` POSTs a body whose `X-Xperiment-Signature` verifies against the secret (stub server), blocks a `http://127.0.0.1`-style private URL when SSRF guard active, and throws on non-2xx; secret never in logs.
- [ ] Run → FAIL → implement → PASS.
- [ ] Commit `feat: add execution-completion webhooks`.

### Task H-4: OpenAPI + web + e2e + docs + verify + merge

**Files:**
- Create: `apps/api/src/openapi.ts` (OpenAPI 3.1 object), `apps/api/src/routes/openapi.ts` (`GET /v1/openapi.json`), register in `server.ts`
- Modify: `apps/web/src/lib/api.ts` (`cancelExecution`, `retryExecution`), `statusMeta.ts` (`CANCELED` → `⊘` muted), `src/app/(app)/executions/[id]/page.tsx` (Cancel/Retry buttons)
- Modify: e2e — a completion-webhook flow (stub receives a signed completion) + a cancel-a-suspended-run flow
- Modify: `README.md` (Public API section)
- Test: `apps/api/test/openapi.test.ts`

- [ ] `GET /v1/openapi.json` parses (JSON.parse of the response) and lists `/v1/executions/{id}/retry`, `/cancel`, `/v1/workflows`, security scheme; served without auth and not rate-limited.
- [ ] Web: retry/cancel buttons + CANCELED status; `pnpm --filter @xperiment/web typecheck` green.
- [ ] e2e: completion webhook delivered + verified; cancel flow → CANCELED.
- [ ] Full verification: `pnpm run test:cov` exit 0, `pnpm typecheck` exit 0, `pnpm --filter @xperiment/e2e test` green, `pnpm --filter @xperiment/web e2e` green.
- [ ] Commit `feat: add OpenAPI spec and web retry/cancel` then `docs: document public API hardening`.
- [ ] Adversarial review (security: callback SSRF + secret leak + rate-limit bypass, cancel/retry authz + cross-tenant; correctness: cancel race, retry idempotency, callback signature + retry, terminal enqueue once; TS; test-gaps). Fix confirmed findings; re-verify.
- [ ] Fast-forward merge `feature/phase2-public-api` → master; delete branch.

## Self-Review Notes

- Retry is a plain new execution (replay) — no partial-node surgery, and it flows through the same rate limiter + idempotency as any execute.
- The callback is delivered off the finalize path via the outbox → queue → consumer, so a slow/failed receiver never blocks or fails the execution's finalization; BullMQ owns retries.
- `assertUrlAllowed` is the single SSRF gate, shared with `http.request`; the callback secret is only ever used to compute the HMAC sent to the receiver.
- CANCELED is a first-class terminal status so metering (sub-project I) and the UI can distinguish it from FAILED.
