# Xperiment Workflow Builder — Phase 0 Technical Proof

Deterministic workflow runtime: versioned Workflow IR, three services
(api / orchestrator / worker) over PostgreSQL + Redis/BullMQ, at-least-once
delivery with idempotency, automatic retry, and a full execution audit trail.

- Spec: `docs/superpowers/specs/2026-07-23-phase0-technical-proof-design.md`
- Plan: `docs/superpowers/plans/2026-07-23-phase0-technical-proof.md`

## Prerequisites

- Node.js >= 20, pnpm >= 10, Docker Desktop

## Quickstart

```bash
docker compose up -d
pnpm install
pnpm migrate
```

Run the three services (three terminals):

```bash
pnpm --filter @xperiment/api dev
```

```bash
pnpm --filter @xperiment/orchestrator dev
```

```bash
pnpm --filter @xperiment/worker dev
```

Create, publish, and run a workflow:

```bash
pnpm xperiment workflow create --name "Lead check" --definition examples/lead-check.json
```

```bash
pnpm xperiment workflow publish <workflowId>
```

```bash
pnpm xperiment run <workflowId> --input payload.json --watch
```

with `payload.json` like `{ "name": "Budi", "total": 150 }`.

Set `HTTP_ALLOW_PRIVATE_IPS=true` on the worker when your workflow calls
localhost URLs (the SSRF guard blocks private ranges by default).

Defaults point at the local stack: `DATABASE_URL=postgresql://postgres:dev_password_change_me@localhost:5432/xperiment`
and `REDIS_URL=redis://:dev_password_change_me@localhost:6379/0` (see `.env.example`; the
committed docker-compose recreates the same services).

## Tests

```bash
docker compose up -d
```

```bash
pnpm test
```

```bash
pnpm test:cov
```

```bash
pnpm --filter @xperiment/e2e test
```

The e2e suite spawns all three services, drives them through the public API
against a local stub HTTP server, and includes the Phase 0 exit criterion:
the same workflow + input executed 5 times must produce identical terminal
results, plus worker-crash recovery via BullMQ stalled-job redelivery.

## Triggers (Phase 1A)

Webhook and schedule triggers start executions without `POST /execute`:

1. Build a workflow whose entrypoint is a `webhook.trigger`
   (`parameters: { authMode: 'none'|'token'|'hmac', idempotencyKeyPath?: 'event.id' }`)
   or `schedule.trigger` (`parameters: { cron: '*/5 * * * *', timezone?: 'Asia/Jakarta' }`;
   6-field seconds cron supported).
2. Publish it, then `POST /v1/workflows/:id/activate` — the response contains the
   production URL (`{GATEWAY_URL}/t/:routeKey`), a test URL (`/t/test/:routeKey`, works
   while inactive and records sample payloads), and the generated secret.
3. Sign production calls: `X-Xperiment-Signature: sha256=<hex(hmac-sha256(secret, rawBody))>`
   for `hmac` mode, or `Authorization: Bearer <secret>` for `token` mode.
4. Duplicate deliveries are deduped by `idempotencyKeyPath` → `Idempotency-Key` header →
   raw-body hash. `POST /v1/workflows/:id/deactivate` stops production traffic without
   touching definitions or running executions.

Run the two extra services alongside the core three:

```bash
pnpm --filter @xperiment/gateway dev
```

```bash
pnpm --filter @xperiment/scheduler dev
```

## Authentication (Phase 1C)

Every control-plane API call requires a bearer token; the data plane (webhook
gateway, scheduler, workers) inherits tenant context from the rows it processes.

1. `POST /v1/auth/register` `{ email, password }` → a session token (`qs_…`) and your
   personal workspace. `POST /v1/auth/login` re-issues; `POST /v1/auth/logout-all`
   revokes every session. Login is rate-limited and audited.
2. Send `Authorization: Bearer <token>`; switch workspaces with the
   `X-Xperiment-Workspace` header (requires membership). See *Roles & permissions* below.
3. `POST /v1/workspaces/invites` returns a one-time token another logged-in
   user redeems via `POST /v1/invites/accept` (email delivery lands later).
4. `POST /v1/api-keys` issues a `qk_…` key shown once, carrying its own role.
   CLI: `pnpm xperiment login --email … --password …` stores the token in
   `~/.xperiment/credentials.json` (`XPERIMENT_TOKEN` env overrides).

Cross-tenant isolation is enforced by workspace-scoped repositories and proven by an
IDOR test matrix (`apps/api/test/isolation.test.ts`, `e2e/test/isolation.test.ts`).

## Roles & permissions (Phase 3M)

Six built-in roles. The ladder is gone: gates name a **capability**, so Operator can
run without authoring and Billing sees spend without touching workflows. A refused
call returns 403 `Requires the '<permission>' permission`.

| Permission | viewer | operator | billing | builder | admin | owner |
|---|---|---|---|---|---|---|
| `workflow:read` `execution:read` `alert:read` `usage:read` | ✓ | ✓ | partial¹ | ✓ | ✓ | ✓ |
| `execution:run` `execution:cancel` `approval:decide` `alert:write` | | ✓ | | ✓ | ✓ | ✓ |
| `workflow:write` `workflow:activate` `connection:read` `connection:write` | | | | ✓ | ✓ | ✓ |
| `billing:read` `billing:manage` | | | ✓ | | ✓ | ✓ |
| `member:manage` | | | | | ✓ | ✓ |

¹ Billing holds `alert:read` + `usage:read` only — not workflows or executions.

- `connection:read` gates `GET /v1/connections`: credential metadata is shared by role
  (SEC-004), so viewers, operators, and billing cannot enumerate connections.
- API keys are issued with a role (`POST /v1/api-keys` `{ name, role? }`, default
  `builder`) and authenticate with exactly that role's permissions.
- `GET /v1/workspaces/members` lists members; `PUT /v1/workspaces/members/:userId`
  `{ role }` changes one. Demoting the last owner is refused with 409, and only an
  owner may grant `owner` (403 otherwise) — the same rule applies to invites and keys.
- The web app exposes this at `/members`. `hasPermission` fails closed on an unknown
  role, and `apps/api/test/rbac.test.ts` asserts the full role × permission matrix
  against the live routes.

## Connections (Phase 1B, extended in 2G)

Credentialed connectors reference stored connections instead of embedding secrets:
`postgres.query`, `telegram.sendMessage`, `openai.chat`, `gemini.generate`, plus the
Phase 2 beta connectors `whatsapp.sendMessage` (Cloud API, token), `email.send` (SMTP —
covers Gmail via an app password), and Google Sheets `sheets.appendRow` / `sheets.getRows`
(service-account key, no OAuth flow this release).

1. `POST /v1/connections` with `{ connectorKey, name, payload }` — payloads are
   validated per connector, AES-256-GCM encrypted at rest, and never returned by the
   API. `POST /v1/connections/:id/test` verifies against the provider.
2. Reference the connection from a node via `connectionRef: "<connection id>"` in the
   IR. Publish fails with `connection_required` / `connection_not_found` /
   `connection_wrong_type` findings until every credentialed node resolves.
3. The worker decrypts just-in-time and passes the payload in memory only — it never
   appears in stored inputs, events, or logs. Provider `baseUrl` overrides in the
   payload support stubbed testing.

## Web UI (Phase 1D)

`apps/web` is a Next.js canvas UI (port 3005) with the Arus design language:
visual workflow editing on React Flow, schema-driven node config forms fed by
`GET /v1/connectors`, draft save with `If-Match` conflict handling, validate /
publish / activate, a connections vault page (secrets write-only), and live
execution timelines.

```bash
pnpm --filter @xperiment/web dev
```

Open http://localhost:3005 (set `NEXT_PUBLIC_API_URL` if the API is not on
`http://localhost:3000`). Canvas layout positions persist in the draft under
`metadata.layout`.

Playwright covers the critical path (register → build on canvas → publish →
activate → webhook fire → green timeline, plus connection secret hygiene and
workspace isolation). It spawns the five services on ports 3100–3104 itself:

```bash
pnpm --filter @xperiment/web e2e
```

Flow screenshots land in `apps/web/e2e/artifacts/`.

## Public API (Phase 2H)

The REST API is hardened for external use:

- **Retry / cancel** — `POST /v1/executions/:id/retry` replays a run as a new execution
  (honoring `Idempotency-Key`); `POST /v1/executions/:id/cancel` stops a running execution
  (new terminal status `CANCELED`), skips its live nodes, and closes any open waits.
- **Rate limits** — every `/v1` response carries `X-RateLimit-Limit/Remaining/Reset`;
  over the limit returns `429` with `Retry-After` (fixed window per workspace, in-memory
  for this single-instance beta; `RATE_LIMIT_PER_MIN` default 600).
- **Completion webhooks** — `PUT /v1/workflows/:id/callback { url }` returns a signing
  secret once; the orchestrator POSTs `{ executionId, workflowId, status, completedAt }`
  to that URL on any terminal state, SSRF-guarded and `X-Xperiment-Signature` (HMAC-SHA256)
  signed. `DELETE` clears it.
- **OpenAPI** — `GET /v1/openapi.json` (public) documents the `/v1` surface.

## Usage metering (Phase 2I)

Every unit of work an execution consumes is written to an **append-only**
`usage_events` ledger, exactly once, inside the same CAS-guarded transaction that
finalizes the execution (so a redelivered job never double-counts):

- `execution` — one row per terminal run, tagged with its `status`
  (SUCCEEDED / FAILED / TIMED_OUT / CANCELED).
- `node` — number of nodes that ran.
- `compute_ms` — execution wall-clock duration.
- `ai_tokens` — OpenRouter tokens per `/v1/ai/*` call (recorded best-effort, so a
  metering write never fails a generation).

`GET /v1/usage?from&to` returns tenant-scoped totals plus a daily series
(`from`/`to` are optional ISO dates; the default period is the current UTC month).
The web **Usage** page renders the totals as scorecards (runs, success rate, nodes,
compute, AI tokens) with a runs-per-day chart.

## Templates & WhatsApp vertical pack (Phase 2L)

A curated, built-in template catalog — starting with an Indonesian **WhatsApp
vertical pack** — lets builders start from a proven blueprint instead of a blank canvas:

- `GET /v1/templates?category=` — browse templates (id, name, description, category,
  use case, `requiredConnectors`).
- `GET /v1/templates/:id` — preview the full workflow IR + required credentials (TMP-002).
- `POST /v1/templates/:id/clone` — creates a **new workflow whose draft is the template
  IR** (credentialed nodes have no connection yet). Attach the WhatsApp connection,
  review on the canvas, and publish — publish-gating enforces `connection_required`.

Shipped templates: **WhatsApp lead auto-reply**, **WhatsApp order receipt**, and
**WhatsApp appointment reminder**. Each is a validated IR (the catalog test proves every
template validates and its `requiredConnectors` is accurate). The web **Templates**
gallery browses the pack and clones with one click.

## Version diff & rollback (Phase 2K)

Published workflow versions are immutable; two of them (or a draft) can be compared,
and any version can be rolled forward:

- `GET /v1/workflows/:id/diff?from=&to=` — `from`/`to` are each a version id or the
  literal `draft`. Returns a **semantic** diff: `nodes` and `edges` each split into
  `added` / `removed` / `modified` (modified nodes list the changed fields —
  type, operationVersion, parameters, connectionRef; layout is ignored), plus a
  `changed` flag.
- `POST /v1/workflows/:id/versions/:versionId/rollback` — publishes an old version's
  IR forward as a **new** version (WFL-006); history is never mutated.

The web **History** page (linked from the workflows list) lists versions and renders
the compare + rollback UI.

## Alerts (Phase 2J)

Define alert rules that the scheduler evaluates every sweep over the usage ledger:

- `failure_rate` — fires when `failed/total` executions over a window ≥ threshold
  (guarded by a minimum sample size).
- `usage_threshold` — fires when a usage metric
  (`execution` / `node` / `compute_ms` / `ai_tokens`) over a window ≥ threshold.

A breach (past the rule's cooldown) records an append-only firing that surfaces in
the in-app **Alerts** feed and an incident banner (unacknowledged count). A rule may
also set a webhook URL, which receives an `X-Xperiment-Signature` (HMAC-SHA256), SSRF-guarded,
retrying POST via the worker. `POST /v1/alerts` returns the signing secret once;
`GET /v1/alerts/events` lists firings and `POST /v1/alerts/events/:id/ack` acknowledges one.

Firing is idempotent per cooldown (`last_fired_at` + `FOR UPDATE SKIP LOCKED`), and
a webhook-delivery failure never removes the in-app firing.

## Wait & Human Approval (Phase 2F)

Three logic nodes suspend an execution **without holding a worker**, and resume
durably (surviving a restart):

- `core.delay` — wait a fixed duration, then continue.
- `core.waitForEvent` — suspend until an external system calls the resume URL.
- `core.approval` — suspend until a human approves or rejects, with an expiry and a
  fallback decision (`approve` / `reject` / `fail`). Output ports `approved` / `rejected`.

A suspended node becomes `WAITING`; timers and expiries are swept by the scheduler
(durable, DB-backed). Resume happens three ways, all through one code path:

- **Approvals** — `GET /v1/approvals` lists pending approvals; `POST
  /v1/executions/:id/approvals/:nodeId` `{ decision, comment }` (builder role,
  workspace-scoped, audited) resolves one. The web **Approvals** page drives this.
- **External event** — the gateway `POST /r/:resumeToken` resumes a `waitForEvent`
  node with the request body as its output. The resume URL appears in the execution
  detail's `waits[]` while the wait is open.
- **Timer / expiry** — the scheduler resumes due delays and applies the approval
  fallback when one expires.

Nothing auto-approves: an execution with an open wait is skipped by the global
watchdog and bounded only by its own expiry.

## AI Builder (Phase 1E)

Describe a workflow in plain language and get a validated draft on the canvas.
The AI dock in the editor calls two builder-gated endpoints:

- `POST /v1/ai/generate` `{ prompt }` → a new draft workflow IR.
- `POST /v1/ai/edit` `{ prompt, definition }` → a revised IR from the current draft.

Generation runs server-side through OpenRouter (OpenAI-compatible). The model's
output is JSON-extracted and run through the same `validateWorkflow` gate that
publishing uses; on failure the findings are fed back for a bounded **repair loop**
(3 attempts) before returning `422` with the findings. Nothing is auto-saved or
published — the draft lands on the canvas for the user to review.

Configure via env (the key stays server-side; the browser only sends a prompt):

```bash
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
OPENROUTER_BASE_URL=https://openrouter.ai
```

Without `OPENROUTER_API_KEY` the AI routes return `503 ai_unconfigured` and the rest
of the app is unaffected.

## Layout

```text
packages/  ir | expressions | engine-core | connectors | db | queue | ai
apps/      api (3000) | orchestrator (3001) | worker (3002) | gateway (3003) | scheduler (3004) | web (3005) | cli
e2e/       end-to-end scenario suite
```
