# Phase 1 Sub-project A: Webhook + Schedule Triggers — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (Phase 0 runtime merged); branch `feature/phase1-triggers`
**PRD requirements covered:** TRG-002, TRG-003, TRG-007 (none/token/HMAC subset), TRG-008,
TRG-010 (sample capture), WFL-004 (activate/deactivate). HLD §12 (trigger design), §8.6
(trigger gateway), §8.7 (scheduler).

---

## 1. Goal

Make the Phase 0 runtime externally drivable: external systems start executions via
authenticated webhooks, and cron schedules start them on time — with the same
at-least-once + idempotency guarantees the runtime already provides.

## 2. Scope

### In scope

- Node types `webhook.trigger` and `schedule.trigger` (registry + IR validation).
- `apps/gateway` (port 3003): webhook ingestion with fast-ack, auth, dedup,
  test/production endpoints, sample capture.
- `apps/scheduler` (port 3004): cron firing with DB lease, timezone support,
  misfire skip-forward.
- Workflow activation lifecycle: `activate`/`deactivate` endpoints; trigger row
  materialization; `workflows.active` flag.
- Migration `0002_triggers.sql`; `triggers` repository; trigger secret encryption
  (AES-256-GCM, key from `TRIGGER_SECRET_KEY` env; replaced by the credential vault in
  sub-project B).
- API: `GET /v1/workflows/:id/triggers`, `GET /v1/workflows/:id/triggers/:nodeId/samples`.

### Out of scope (later sub-projects)

Basic-auth webhook mode (token covers the use case), polling triggers, connector event
triggers, email triggers, trigger replay UI, secret rotation endpoints, per-trigger rate
limits, sync response mode, multi-environment activation.

## 3. Node types

| Type | Kind | Parameters (zod) | Runner output |
|---|---|---|---|
| `webhook.trigger` | trigger | `{ authMode: 'none'\|'token'\|'hmac', idempotencyKeyPath?: string }` | passthrough of stored trigger payload `{ body, headers, query }` |
| `schedule.trigger` | trigger | `{ cron: string (5- or 6-field, validated via cron-parser), timezone?: string (IANA, default 'Asia/Jakarta') }` | `{ firedAt, scheduledFor }` |

- Cron validity and timezone validity are checked at IR validation (zod `.refine` calling
  cron-parser / `Intl.supportedValuesOf('timeZone')`).
- `idempotencyKeyPath` is a dot-path into the request **body** (e.g. `event.id`); no
  expression engine runs in the gateway.
- Secrets never appear in the IR (`authMode` only). The system generates secrets at
  activation.

## 4. Data model — migration `0002_triggers.sql`

```sql
ALTER TABLE workflows ADD COLUMN active BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE workflow_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,                        -- 'webhook' | 'schedule'
  route_key TEXT NOT NULL UNIQUE,            -- stable random URL key (webhook)
  auth_mode TEXT NULL,                       -- webhook only
  secret_encrypted BYTEA NULL,               -- AES-256-GCM(iv || tag || ciphertext)
  idempotency_key_path TEXT NULL,
  cron TEXT NULL,                            -- schedule only
  timezone TEXT NULL,
  next_fire_at TIMESTAMPTZ NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, node_id)
);
CREATE INDEX idx_workflow_triggers_due
  ON workflow_triggers (next_fire_at) WHERE active AND type = 'schedule';
```

- `route_key`: 24-byte base64url random; preserved across re-activations
  (`ON CONFLICT (workflow_id, node_id)` keeps the existing row/key).
- Secret encryption helper lives in `packages/db/src/crypto.ts`:
  `encryptSecret(plaintext, key)` / `decryptSecret(buf, key)`; key = 32 bytes from
  `TRIGGER_SECRET_KEY` (base64; a documented dev default lives in `.env.example`).

## 5. Activation lifecycle (WFL-004)

- `POST /v1/workflows/:id/activate` — 409 unless a published version exists. Parses the
  active version IR, upserts one `workflow_triggers` row per trigger node (generating
  `route_key` + secret on first creation; recomputing `next_fire_at` for schedules from
  now), marks rows + workflow `active = true`. Returns triggers incl. webhook URLs and
  the decrypted secret.
- `POST /v1/workflows/:id/deactivate` — sets workflow + trigger rows `active = false`.
  Running executions are untouched (PRD: deactivation stops new triggers only).
- Re-publish does not touch activation; re-activate rebinds triggers to the new active
  version's nodes. Trigger nodes removed from the new version get their rows deleted on
  re-activation.
- `manual.trigger` nodes produce no trigger rows; `POST /execute` behavior is unchanged
  and works regardless of `active`.

## 6. Gateway (`apps/gateway`, port 3003)

Endpoints:

- `POST /t/:routeKey` — production. 404 if the trigger or workflow is not active.
- `POST /t/test/:routeKey` — test mode. Works while inactive (trigger row must exist —
  activation ran at least once). Creates executions with `mode = 'test'`.
- `GET /healthz`.

Fast-ack pipeline (target: no external calls before the 202):

1. Body size cap 1 MB (Fastify `bodyLimit`) → 413.
2. Resolve trigger by `route_key` (single indexed query) → 404 if missing/inactive.
3. Verify auth per `auth_mode`:
   - `token`: `Authorization: Bearer <secret>` compared constant-time
     (`crypto.timingSafeEqual`).
   - `hmac`: `X-Xperiment-Signature: sha256=<hex>` = HMAC-SHA256(secret, raw body bytes).
   - `none`: skip. Failures → 401 problem (no detail about which check failed).
4. Dedup key precedence: value at `idempotency_key_path` in the parsed body →
   `Idempotency-Key` header → SHA-256 of the raw body. Key is scoped per workflow by the
   existing `UNIQUE(workflow_id, idempotency_key)` on `trigger_events`.
5. Resolve the workflow's current `active_version_id`, parse node ids, call the existing
   `createExecutionWithTrigger` (single transaction; payload =
   `{ body, headers: sanitized, query }`; headers drop `authorization`, `cookie`,
   `x-xperiment-signature`).
6. `202 { executionId, created: true }`; duplicates return `200 { created: false }`.

Test executions carry `mode='test'`; sample capture (TRG-010) = the stored
`trigger_events` payloads of recent test executions, exposed via
`GET /v1/workflows/:id/triggers/:nodeId/samples` (last 5).

## 7. Scheduler (`apps/scheduler`, port 3004)

Loop every `SCHEDULER_INTERVAL_MS` (default 5000):

```sql
SELECT * FROM workflow_triggers
WHERE type = 'schedule' AND active AND next_fire_at <= now()
FOR UPDATE SKIP LOCKED LIMIT 20
```

Per due trigger (inside the same transaction):

1. `scheduledFor = next_fire_at`. If `now() - scheduledFor > 60s` (grace), skip forward:
   recompute `next_fire_at` from now, log `schedule.misfire_skipped`, do not fire.
2. Otherwise fire: `createExecutionWithTrigger` with idempotency key
   `sched:{triggerId}:{scheduledFor.toISOString()}` (duplicate-safe across replicas) and
   payload `{ firedAt: now, scheduledFor }`.
3. Recompute `next_fire_at` via cron-parser (`{ currentDate: scheduledFor, tz }`), update
   the row.

Multiple scheduler replicas are safe: `SKIP LOCKED` is the lease; the idempotency key is
the backstop. Cron math lives in a pure module (`apps/scheduler/src/cron.ts`) —
`nextFireAt(cron, tz, from)` — unit-tested incl. 6-field seconds cron and DST.

## 8. API and service wiring

- New API routes registered in `apps/api`: activate, deactivate, list triggers (with
  URLs built from `GATEWAY_URL` env, default `http://localhost:3003`), samples.
- `apps/gateway` and `apps/scheduler` follow the existing service pattern: tsx entry,
  pino, healthz, migrations at boot, graceful shutdown; both get `start`/`dev` scripts
  and join the e2e spawn set (ports 3103/3104 in e2e).
- New env vars: `TRIGGER_SECRET_KEY`, `GATEWAY_PORT`, `SCHEDULER_PORT`,
  `SCHEDULER_INTERVAL_MS`, `GATEWAY_URL`.

## 9. Testing

- **Unit:** token/HMAC verification matrix (valid, invalid, missing, wrong scheme,
  timing-safe paths), dot-path extraction, header sanitization, cron `nextFireAt`
  (5-field, 6-field seconds, timezone, DST boundary, invalid cron rejection), misfire
  grace decision, secret encrypt/decrypt round-trip + tamper detection.
- **Integration:** activation materializes rows and preserves `route_key` across
  re-activation; deactivation flips flags; gateway route → execution row created with
  sanitized payload; duplicate webhook → single execution; scheduler two concurrent
  pollers fire once (SKIP LOCKED + idempotency); samples endpoint returns test payloads.
- **E2E (extends the existing suite):** activate → HMAC-signed webhook → SUCCEEDED
  execution with `trigger.body.body` mapped through the workflow; bad signature → 401
  and no execution; duplicate delivery → one execution; seconds-cron schedule fires a
  real execution within the test window; deactivate → production URL 404 while test URL
  still works.
- Coverage thresholds unchanged (≥80% all packages).

## 10. Risks

| Risk | Mitigation |
|---|---|
| Gateway auth bypass | Constant-time compares, raw-body HMAC, unit matrix, no auth detail in errors |
| Scheduler double-fire across replicas | SKIP LOCKED lease + deterministic idempotency key |
| Env-key secret encryption is weaker than a vault | Explicitly temporary; sub-project B migrates storage; key never logged |
| Cron/timezone edge cases | Pure cron module, DST tests, IANA validation at IR validation |
