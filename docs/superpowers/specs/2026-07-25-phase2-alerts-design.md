# Phase 2 Sub-project J — Alerts — Design

**Status:** Approved (design gate 2026-07-25)
**Requirements:** PRD MON-005 (alert on failure rate / latency / credential expiry / quota), MON-010 (in-app incident banner / status).
**Out of scope (later slices):** latency alerts (no percentile store yet), credential-expiry alerts (connections don't track expiry), status-page integration, alert delivery via stored connectors (email/WA/telegram) — webhook delivery only this slice.

## Goal

Let a workspace define alert rules that the scheduler evaluates continuously; when a rule breaches (and is past its cooldown) record an append-only firing, surface it in an in-app feed + incident banner, and optionally deliver a signed webhook.

## Conditions (this slice)

Both derived from Sub-project I's `usage_events` ledger over a rolling window `[now − windowMinutes, now)`:

| type | params | fires when |
|---|---|---|
| `failure_rate` | `{ windowMinutes, threshold (0..1), minSample }` | `total ≥ minSample AND failed/total ≥ threshold` where total = count of `execution` rows, failed = those with `metadata->>'status' = 'FAILED'` |
| `usage_threshold` | `{ windowMinutes, metric ('execution'\|'node'\|'compute_ms'\|'ai_tokens'), threshold }` | `SUM(quantity) FILTER (metric = params.metric) ≥ threshold` |

## Architecture

**Rules evaluated by the scheduler; firings are a durable append-only log.** `alert_rules` are evaluated on the existing scheduler sweep (`apps/scheduler` already runs `runSchedulerTick` + `runWaitSweep` every `SCHEDULER_INTERVAL_MS`, default 5s). A new `runAlertSweep` selects due rules with `FOR UPDATE SKIP LOCKED`, evaluates each in its own savepoint, and on breach — in the same transaction — inserts an `alert_events` row, sets `last_fired_at = now()` (the cooldown guard), and, if a webhook is configured, inserts an `alert.notify` outbox row. Cooldown + the `last_fired_at` update inside the `FOR UPDATE` selection make firing idempotent per cooldown window and safe across multiple scheduler instances.

Delivery rides the existing at-least-once outbox → BullMQ → worker path (H's completion-webhook pattern): a worker consumer POSTs a signed payload with `attempts` + exponential backoff. Delivery failure never removes the in-app event — the feed/banner is the source of truth.

Rejected alternatives: **event-driven per-execution evaluation** (evaluate on every `node.completed`) couples alerting to the hot execution path and can't express windowed rates cleanly; **a separate alert daemon** duplicates the scheduler's already-present, tested sweep loop.

## Components

### packages/db

- **Migration `0008_alerts.sql`:**
  ```sql
  CREATE TABLE alert_rules (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id              UUID NOT NULL REFERENCES workspaces(id),
    name                      TEXT NOT NULL,
    type                      TEXT NOT NULL,               -- 'failure_rate' | 'usage_threshold'
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
    detail           JSONB NOT NULL,                       -- { type, observed, threshold, windowMinutes, ... }
    acknowledged_at  TIMESTAMPTZ NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_alert_events_workspace ON alert_events (workspace_id, fired_at DESC);
  ```
- **`repos/alerts.ts`:**
  - Types: `AlertType = 'failure_rate' | 'usage_threshold'`; `AlertRuleRow`, `AlertEventRow`.
  - `createAlertRule(db, {workspaceId, name, type, params, webhookUrl?, webhookSecretEncrypted?, cooldownMinutes?}) → AlertRuleRow`
  - `listAlertRules(db, workspaceId) → AlertRuleRow[]`
  - `getAlertRule(db, id, workspaceId) → AlertRuleRow | null`
  - `updateAlertRule(db, id, workspaceId, patch: {name?, params?, enabled?, cooldownMinutes?}) → AlertRuleRow | null`
  - `deleteAlertRule(db, id, workspaceId) → boolean`
  - `dueAlertRules(client) → AlertRuleRow[]` — `SELECT … WHERE enabled AND (last_fired_at IS NULL OR last_fired_at < now() - make_interval(mins => cooldown_minutes)) FOR UPDATE SKIP LOCKED`.
  - `evaluateFailureRate(db, {workspaceId, windowStart}) → { total: number; failed: number }`
  - `evaluateUsageMetric(db, {workspaceId, metric, windowStart}) → number`
  - `fireAlert(client, {rule, detail, firedAt}) → AlertEventRow` — inserts `alert_events`, sets `last_fired_at`, and (when `webhook_url` set) inserts an `alert.notify` outbox row `{ ruleId, eventId }`.
  - `listAlertEvents(db, workspaceId, limit) → AlertEventRow[]`
  - `countUnacknowledgedAlerts(db, workspaceId) → number`
  - `acknowledgeAlert(db, id, workspaceId) → boolean`
  - `getAlertWebhook(db, ruleId) → { url; secretEncrypted } | null`
  - Export from `packages/db/src/index.ts`.

### apps/scheduler

- **`alertSweep.ts`:** `runAlertSweep(deps: { pool; log }) → { fired: number }`. Wraps `dueAlertRules` in a `withTx`; for each rule, `SAVEPOINT`, compute `windowStart = now − params.windowMinutes`, evaluate the condition, and on breach call `fireAlert` with a `detail` capturing the observation; a per-rule error rolls back to the savepoint and logs `alert_sweep.rule_failed`.
- **`main.ts`:** add `runAlertSweep({ pool, log })` to the `Promise.all([...])` in the interval loop.

### packages/queue

- `QUEUE_NAMES.alertNotify = 'alert.notify'`; add to `EVENT_TO_QUEUE`, `createQueues` (with the same `attempts`/backoff profile as `executionCallback` via a shared const), and `jobIdFor` → `alert_${eventId}`.

### apps/worker

- **`alertDelivery.ts`:** `runAlertDelivery(deps: { pool; alertKey: Buffer; allowPrivateIps; log }, { ruleId, eventId })`. Loads the rule webhook via `getAlertWebhook`; no-op + log if absent. `await assertUrlAllowed(url, { allowPrivate })`; POST `{ ruleId, ruleName, workspaceId, firedAt, detail }` with `X-Xperiment-Signature: sha256=<hmac(secret, body)>`, 10s timeout; throw on non-2xx so BullMQ retries. Secret decrypted just-in-time, never logged.
- **`main.ts`:** add an `alertWorker` (BullMQ Worker on `QUEUE_NAMES.alertNotify`, concurrency 4), closed on shutdown. Reuses the trigger/credentials key derivation for the HMAC secret.

### apps/api

- **`routes/alerts.ts`** (builder role, tenant-scoped, rate-limited, not auth-exempt):
  - `POST /v1/alerts` `{ name, type, params, webhookUrl?, cooldownMinutes? }` — zod-validates `params` per `type`; if `webhookUrl`, generate a 24-byte base64url secret, `encryptSecret`, store, and return `{ …rule, secret }` **once**.
  - `GET /v1/alerts` — list rules (secrets never returned).
  - `PUT /v1/alerts/:id` `{ name?, params?, enabled?, cooldownMinutes? }` — update.
  - `DELETE /v1/alerts/:id` — 204.
  - `GET /v1/alerts/events?limit` — recent firings + `{ unacknowledged: number }`.
  - `POST /v1/alerts/events/:id/ack` — set `acknowledged_at`.
  - Register in `server.ts`; add paths to `OPENAPI_DOCUMENT`.

### apps/web

- **`/alerts` page:** rules list (name, type, enabled toggle, cooldown), a create form (type select → conditional params fields), and a firing feed (recent `alert_events` with ack buttons). Arus design, consistent with the approvals/usage pages.
- **Incident banner:** in the app shell, poll `GET /v1/alerts/events`; when `unacknowledged > 0` show a dismissible banner linking to `/alerts` (MON-010).
- **`lib/api.ts`:** `listAlerts`, `createAlert`, `updateAlert`, `deleteAlert`, `listAlertEvents`, `acknowledgeAlert` + types.
- Nav: add an "Alerts" link.

## Data flow

```
scheduler sweep (5s)
  └─ runAlertSweep → dueAlertRules (FOR UPDATE SKIP LOCKED)
       per rule (savepoint): evaluate over usage_events [now-window, now)
         breach → fireAlert: insert alert_events + set last_fired_at + (if webhook) outbox 'alert.notify'
outbox → alert.notify queue → worker runAlertDelivery → signed POST (retries)
GET /v1/alerts/events → feed + unacknowledged count → web banner
```

## Error handling

- Sweep: `dueAlertRules` uses `FOR UPDATE SKIP LOCKED`; each rule evaluates in a savepoint so one failure is isolated and logged (`alert_sweep.rule_failed`). Cooldown + `last_fired_at` prevent re-firing within the window and double-firing across instances.
- Delivery: retrying (BullMQ `attempts`+backoff); a permanently failing webhook never affects the in-app event.
- API: `params` zod-validated per `type` (unknown metric / out-of-range threshold → 400). Webhook secret AES-GCM encrypted at rest, returned once. Cross-tenant rule/event access → 404.
- Firing payload/`detail` never contains secrets or raw execution IO — only counts, ratios, thresholds, window.

## Testing

- **db:** rule CRUD + tenant scoping; `evaluateFailureRate`/`evaluateUsageMetric` over seeded `usage_events`; `dueAlertRules` cooldown selection; `fireAlert` writes event + sets last_fired_at + conditional outbox; `acknowledgeAlert`/`countUnacknowledgedAlerts`.
- **scheduler:** `runAlertSweep` fires when the breach holds, is a no-op under the min-sample guard, respects cooldown (second sweep within cooldown does not re-fire), and writes exactly one event + one outbox row per firing.
- **worker:** `runAlertDelivery` POSTs a correctly-signed body, SSRF-blocks a private URL, and no-ops when the rule has no webhook.
- **api:** CRUD happy paths, per-type `params` validation (400), cross-workspace 404, secret-returned-once, events list + ack.
- **web:** api-client method matrix; alerts page + banner data mapping.
- **e2e:** create a workflow that fails, run it (produces a FAILED `execution` usage row), create a `failure_rate` rule (window covering the run, minSample 1, threshold 0.5, webhook to the stub), invoke `runAlertSweep` (or wait a tick), and assert an `alert_events` firing exists and the stub received a correctly-signed webhook.

Gates before merge: all package suites green, coverage ≥80% (statements/branches/functions/lines) every package, root `typecheck` clean, `@xperiment/e2e` + `@xperiment/web e2e` green, then adversarial multi-agent review, fix confirmed findings, fast-forward merge `feature/phase2-alerts` → master.

## File layout

```
packages/db/src/migrations/0008_alerts.sql        (new)
packages/db/src/repos/alerts.ts                   (new)
packages/db/src/index.ts                           (export)
packages/db/test/alerts.test.ts                    (new)
packages/queue/src/{names,publisher,payloads}.ts   (alert.notify queue + jobId)
packages/queue/test/publisher.test.ts              (alert queue retry config)
apps/scheduler/src/alertSweep.ts                   (new)
apps/scheduler/src/main.ts                          (wire into loop)
apps/scheduler/test/alertSweep.test.ts             (new)
apps/worker/src/alertDelivery.ts                   (new)
apps/worker/src/main.ts                             (alert worker)
apps/worker/test/alertDelivery.test.ts             (new)
apps/api/src/routes/alerts.ts                      (new: /v1/alerts…)
apps/api/src/server.ts                              (register)
apps/api/src/openapi.ts                             (paths)
apps/api/test/alerts.test.ts                       (new)
apps/web/src/app/(app)/alerts/page.tsx             (new)
apps/web/src/components/shell/{Sidebar,IncidentBanner}.tsx
apps/web/src/lib/api.ts                             (client + types)
apps/web/test/api.test.ts                           (matrix)
e2e/test/acceptance.test.ts                         (alert firing + webhook)
README.md                                           (Alerts section)
```
