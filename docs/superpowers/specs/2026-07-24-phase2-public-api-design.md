# Phase 2 Sub-project H: Public API Hardening — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (Phase 0 + Phase 1 A–E + Phase 2 F,G merged); branch `feature/phase2-public-api`
**PRD requirements covered:** the `/v1/executions/{id}/retry` and `/cancel` endpoints
(§10.14), API-004 (rate-limit headers), API-005 (execution-completion webhook), API-006
(OpenAPI spec). Already satisfied in Phase 1 and NOT re-done: API-001 (scoped/revocable
API keys), API-002 (Idempotency-Key on execute), API-003 (cursor pagination + RFC-7807).
**Non-goals (deferred):** distributed rate limiting (in-memory, single-instance for beta);
TypeScript/Python SDKs (API-007/008); a hosted Swagger UI (serve the raw spec only).

---

## 1. Goal

Close the remaining "Public API" gaps: cancel and retry executions, advertise rate limits,
notify external systems on completion, and publish an OpenAPI document.

## 2. Cancel + CANCELED status

- `@xperiment/engine-core`: add `CANCELED` to `EXECUTION_STATUSES`; transitions
  `RUNNING → CANCELED` and `QUEUED → CANCELED`. Every `TERMINAL_EXECUTION_STATUSES` list
  (worker, orchestrator deps) gains `CANCELED`.
- `POST /v1/executions/:id/cancel` — builder role, workspace-scoped. In one tx:
  CAS execution `QUEUED|RUNNING → CANCELED` (`completedAt`, `errorSummary: 'Canceled'`),
  CAS every non-terminal node (`PENDING|READY|QUEUED|RUNNING|WAITING → SKIPPED`), and
  `closeOpenWaits` (reused from F). Idempotent: already-terminal → 409 `already_terminal`.
  In-flight worker tasks are guarded by the existing terminal-status check in `runTask`,
  so a racing node result is a no-op.

## 3. Retry (replay)

- `POST /v1/executions/:id/retry` — builder role, workspace-scoped. Loads the original
  execution's `workflowVersionId` and its trigger payload, then `createExecutionWithTrigger`
  a NEW execution from that same version + payload (honoring an `Idempotency-Key` header;
  default a fresh uuid). Returns `{ executionId, status, created }` (201). The original
  execution is untouched. 404 if the execution/version is gone.

## 4. Rate-limit headers (API-004)

A Fastify plugin runs on `/v1/*` (after auth): a fixed-window in-memory limiter keyed by
`apiKeyId` when present else `workspaceId`. Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` (unix seconds) on every response; over the limit returns `429` with a
`Retry-After` header and an RFC-7807 body. Default 600 req/min, override via
`RATE_LIMIT_PER_MIN`. Exempt paths: `/v1/healthz`, `/v1/openapi.json`. Documented as
single-instance (not cross-node) for beta.

## 5. Completion webhook (API-005)

- Migration 0006: `workflows.completion_webhook_url TEXT`, `completion_webhook_secret_encrypted BYTEA`.
- `PUT /v1/workflows/:id/callback` `{ url }` (builder) — validates the URL, stores it,
  generates + AES-GCM-encrypts an HMAC secret, returns `{ url, secret }` **once**.
  `DELETE /v1/workflows/:id/callback` clears it.
- Orchestrator: when an execution reaches ANY terminal state
  (`SUCCEEDED|FAILED|TIMED_OUT|CANCELED`), if the workflow has a callback URL, `insertOutbox`
  an `execution.callback` event `{ executionId }` in the same finalizing tx.
- Queue: new `execution.callback` queue + `jobIdFor` mapping (`callback_{executionId}`).
- A new callback consumer (added to the worker service's BullMQ workers): loads the
  execution + workflow callback URL/secret, **SSRF-checks the URL with `assertUrlAllowed`**
  (the guard `http.request` uses), then POSTs
  `{ executionId, workflowId, status, completedAt }` with `X-Xperiment-Signature: sha256=<hmac>`
  (same scheme as triggers) and a 10 s timeout. BullMQ retries on failure; non-2xx is a
  retryable failure. The secret/URL never appear in logs or execution events.

## 6. OpenAPI (API-006)

- `GET /v1/openapi.json` (public, no auth, rate-exempt) serves a hand-authored OpenAPI 3.1
  document (a typed object in `apps/api/src/openapi.ts`) covering the `/v1` surface:
  auth, workflows, executions (incl. retry/cancel), connectors, connections, approvals, ai,
  and the security scheme (bearer session/API key + `X-Xperiment-Workspace`). A test asserts it
  parses and lists the key paths.

## 7. Web

- Execution detail: **Cancel** button (when non-terminal) and **Retry** button (always) →
  new `apiClient.cancelExecution` / `retryExecution`; on retry, navigate to the new run.
- `statusMeta('CANCELED')` → `⊘` muted "Canceled".
- Workflow editor: a small "Completion webhook" field under the action bar (set/clear URL,
  shown-once secret) — optional; if it complicates the slice, expose via API only and note it.

## 8. Testing

- **engine-core:** CANCELED transitions.
- **db:** a `cancelExecution` repo helper (CAS + node skips) if extracted; else covered via API.
- **api:** cancel transitions a running execution + skips nodes + closes waits + 409 on
  terminal + cross-tenant 404; retry creates a new execution from the same version + payload
  and honors Idempotency-Key; rate-limit headers present and 429 past the limit (low limit in
  test); callback set/clear returns a shown-once secret and stores encrypted; openapi.json
  parses.
- **queue/worker:** the callback consumer POSTs a signed body to a stub, SSRF-blocks a
  private URL, and retries a non-2xx — against a stub server; secret never logged.
- **orchestrator:** a terminal execution with a workflow callback inserts one
  `execution.callback` outbox event.
- **e2e:** extend a flow — run a workflow with a completion webhook pointed at a stub, assert
  the stub receives a correctly-signed completion; and cancel a (wait-suspended) execution via
  the API and assert CANCELED + closed wait.
- Coverage ≥80% all touched packages; both e2e suites green.

## 9. Risks

| Risk | Mitigation |
|---|---|
| SSRF via user callback URL | `assertUrlAllowed` (same guard as http.request) blocks private ranges before the POST; HTTP_ALLOW_PRIVATE_IPS only in tests |
| Callback secret leakage | Encrypted at rest, decrypted in the consumer only, never in logs/events; HMAC signature, not the secret, is sent |
| In-memory rate limiter not distributed | Documented beta limitation; correct within one instance; a shared store is a later slice |
| Retry storms / idempotency | Retry honors Idempotency-Key; replay is a normal new execution subject to the same rate limiter |
| Cancel racing a worker | `runTask` already no-ops on a terminal execution; cancel CAS-guards every node transition |
