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

## Demo data

An empty install shows empty lists, so nothing in the product can be evaluated.
`xperiment seed` fills a **local** database with a small Indonesian shop: three
published workflows, two connections, and a month of run history with real
failures in it.

```bash
pnpm xperiment seed
```

It refuses to run unless all three gates pass: `NODE_ENV` is not `production`,
`DATABASE_URL` is still the committed development credential, and that URL points
at this machine. The second gate reads backwards on purpose — a database counts
as development *because* nobody has configured it, so the dangerous case is the
one that looks properly set up. `--force` overrides them and exists only as a
flag, never as an environment variable.

Nothing it writes can reach a provider: every fabricated credential carries the
literal `FAKE` and every host is under `.invalid`, which RFC 2606 guarantees can
never resolve. It also never inserts an outbox row, so seeding cannot dispatch
real work to a running worker.

There is no `--reset`. Seeding twice under the same name is refused; on a
development stack, dropping the database and re-running `pnpm migrate` is the
honest reset.

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

- Reads are gated, not just writes: `GET /v1/workflows*`, `/v1/executions*`, `/v1/approvals`,
  `/v1/alerts*` and `/v1/usage` each require their `*:read` permission, so a billing member
  cannot read execution timelines (which carry customer payloads) or workflow IR.
- `connection:read` gates `GET /v1/connections`: credential metadata is shared by role
  (SEC-004), so viewers, operators, and billing cannot enumerate connections.
- `GET /v1/workflows/:id/triggers` omits each webhook's URL and signing secret unless the
  caller holds `workflow:activate`. The gateway authenticates a trigger call on that secret
  alone (on nothing at all when `authMode` is `none`), so handing those to a reader would
  make `workflow:read` a transitive `execution:run`.
- API keys are issued with a role (`POST /v1/api-keys` `{ name, role? }`, default
  `builder`) and authenticate with exactly that role's permissions.
- `GET /v1/workspaces/members` lists members; `PUT /v1/workspaces/members/:userId`
  `{ role }` changes one. Demoting the last owner is refused with 409, and only an
  owner may grant `owner` (403 otherwise) — the same rule applies to invites and keys.
  Role changes take a workspace-scoped advisory lock, so concurrent demotions of two
  different owners cannot both pass the guard and strand the workspace with none.
- The web app exposes this at `/members`. `hasPermission` fails closed on an unknown
  role, and `apps/api/test/rbac.test.ts` asserts the full role × permission matrix
  against the live routes.

## Plans & quota (Phase 3N)

Every workspace has a plan, and four limits derive from it. `null` means unlimited.

| Limit | free | builder | team | business |
|---|---|---|---|---|
| Executions / month | 500 | 10,000 | 50,000 | ∞ |
| AI tokens / month | 50,000 | 500,000 | 2,000,000 | ∞ |
| Active workflows | 3 | 20 | 100 | ∞ |
| Members | 2 | 3 | 15 | ∞ |

The tiers are a hypothesis (PRD §15 defers pricing to customer discovery), so the catalog
is one object in `packages/plans` that a billing provider can replace without touching a
single enforcement site. Enterprise is `business` plus per-workspace `limit_overrides`.

- **Flows are counted at the start, stocks are counted live.** Executions and AI tokens
  increment `workspace_usage_counters` in the same transaction as the event they count;
  active workflows and members are a `count(*)` at check time. The Phase 2I ledger stays
  the billing source of truth and `recomputeCounters` rebuilds the counters from it.
- **Quota counts starts; the Usage page reports finished runs.** A run in flight counts
  against the cap before it appears on the dashboard. Counting finalized runs instead
  would let a workspace at 999/1000 start hundreds of concurrent runs, because none of
  them would have finalized when the check ran.
- **Enforcement points.** `POST /v1/workflows/:id/execute` and `/executions/:id/retry`,
  `/activate`, `/workspaces/invites`, `/ai/generate` and `/ai/edit` return **402** naming
  the metric, usage, limit and reset. The webhook gateway returns a deliberately generic
  **429** — an unauthenticated caller must not learn the workspace's plan state. A blocked
  cron fire is skipped and logged, and `next_fire_at` still advances so an upgrade does
  not release a backlog all at once. Duplicate (idempotent) requests consume no quota.
  A refusal **rolls the whole creation back**, so the idempotency key stays unused: the
  same key runs normally once the plan is upgraded or the period rolls over.
- **Seats are counted at redemption, not at invite.** Issuing invites is free and
  unbounded, so `POST /v1/invites/accept` is the gate (402 when the workspace is full) —
  gating only the issue would let N invites be minted under the cap and all redeemed past
  it. Redemption takes the same workspace advisory lock as a role change, so concurrent
  joins cannot both read the same pre-join seat count.
- **Soft limit at 80%** raises the workspace's *managed* `quota` alert rule, which rides
  Phase 2J's cooldown, acknowledgement, signed webhook delivery and incident banner. It
  can be disabled but not deleted (409).
- **`allowOverage`** turns every block into a warning: work proceeds and the counter keeps
  climbing, so overage is `max(0, used - limit)`.
- `GET /v1/plan` needs `billing:read`; `PUT /v1/plan` needs `billing:manage` and refuses a
  downgrade the workspace already exceeds (409). The web app exposes this at `/plan`.

## Invoices & payment (Phase 3O)

Each closed calendar month becomes one immutable invoice per workspace: a subscription
line plus metered overage, with tax.

| Plan | Monthly | Overage / execution | Overage / 1k AI tokens |
|---|---|---|---|
| free | 0 | — | — |
| builder | Rp 149.000 | Rp 25 | Rp 150 |
| team | Rp 599.000 | Rp 20 | Rp 120 |
| business | Rp 2.499.000 | unlimited, not metered | unlimited, not metered |

The figures are placeholders — PRD §15 defers pricing to customer discovery, and the
whole table is one object in `packages/plans` that a billing provider can replace.

- **All money is integer rupiah.** No float ever touches an amount; DB columns are
  `BIGINT`. Tax is `round(subtotal × rate_bps / 10000)`, stamped onto the invoice **once**
  at issue and never recomputed — changing `INVOICE_TAX_RATE_BPS` affects only invoices
  issued afterwards.
- **The 11% default is a placeholder.** It records whatever rate it is configured with and
  asserts no legal position. A live deployment needs real tax advice.
- **Stock limits are not billed.** `activeWorkflows` and `members` are hard caps enforced
  at their gates, so a workspace can never exceed them; only executions and AI tokens
  meter. A partial thousand of AI tokens rounds up to a whole billable unit.
- **The close sweep is idempotent by construction**, not by being careful:
  `UNIQUE (workspace_id, period_start)` means two scheduler instances racing produce one
  invoice and one skipped duplicate. It only ever closes the *previous* period, and skips
  any workspace created after that period ended.
- **An invoice is immutable except for settlement.** The repo exposes no generic update —
  only `setInvoiceProvider` and a compare-and-set to `paid`, so a replayed webhook or a
  double-clicked button settles nothing twice (409).
- **Payment is behind an interface.** `manual` (bank transfer, admin settles) ships now;
  a Midtrans or Xendit adapter implements the same `PaymentProvider` without touching the
  invoice engine. `verifyWebhook` returns null for anything it cannot positively verify,
  so `POST /v1/payments/:provider/webhook` fails closed with 401 and mutates nothing.
- Routes: `GET /v1/invoices` and `GET /v1/invoices/:id` need `billing:read`;
  `POST /v1/invoices/:id/pay` and `/mark-paid` need `billing:manage`. The web app lists
  them on `/plan`.
- Config: `INVOICE_TAX_RATE_BPS` (default 1100), `PAYMENT_PROVIDER` (default `manual`; an
  unknown key fails at **startup**, not per request), `PAYMENT_WEBHOOK_SECRET` (unset means
  every webhook is refused rather than verified against an empty string).

**Not in this slice:** dunning and retry schedules, refunds, credit notes, proration on a
mid-period plan change (the plan active at close is charged), multi-currency, and faktur
pajak e-filing.

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

## Loops & error paths (LOGIC-002, LOGIC-004)

`core.loop` takes an array and runs the nodes scoped to it once per item. The body stays in
the top-level node list carrying `scope: { loopId }`; at run time the orchestrator rewrites the
graph, cloning each body node per iteration as `b1#0`, `b1#1`, … and adding a synthetic
`lp$join` that the loop's `done` edges leave from. **The scheduler itself knows nothing about
loops** — `computeReadiness` runs unchanged over the derived graph. Because the IR id pattern
forbids `#` and `$`, these ids can never collide with an authored one, and no migration was
needed.

Each instance keeps its own status, retry, timeout and timeline row, and can suspend — so
`core.delay` and `core.approval` work **inside** a loop body. A body node never runs under its
authored id, so executions seed only the unscoped nodes (`runnableNodeIds`).

`maxIterations` (default 100, max 1000) caps the list; exceeding it **fails the loop node**
rather than truncating silently. `concurrency` (default 1, max 10) bounds how many iterations
are in flight; the limit is applied at dispatch, not in the scheduler, and a second node of an
iteration already under way does not spend a fresh slot.

`done` carries `{ count }` and **not** the iteration outputs. Aggregating them would run into
`PAYLOAD_CAP_BYTES` at the last step, after all the work; collecting results across iterations
belongs with EXE-009 object storage and is not built. The loop node's own output *does* hold
the resolved items, so each iteration's context can expose `loop.item` and `loop.index` — which
means the practical ceiling on a loop is the payload cap, not `maxIterations`. Inside a body,
an expression naming a sibling node resolves to that iteration's copy.

An **error path** is configured per node with `settings.onError` and workflow-wide with
`metadata.onError`, both `fail` (the default, and the behaviour every existing workflow keeps)
or `continue`. An explicit edge on a node's `error` port wins over either. A node that fails is
still recorded **FAILED** — the database records what happened, the scheduler decides what it
means — and a handled failure contributes `{ error: … }` so the branch handling it can read the
failure. Inside a loop body an error edge must stay inside that body.

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

## Security: envelope encryption & audit (Phase 3P)

Stored secrets sit under a three-tier key hierarchy. A root key — a Cloud KMS CryptoKey
in production — wraps one KEK per workspace, held as ciphertext in `workspace_keys`. That
KEK wraps a fresh data key for every individual secret, using local AES-256-GCM with no
network call. KMS is therefore consulted once per workspace per cache window rather than
once per secret, and destroying a single `workspace_keys` row makes every credential in
that workspace permanently unreadable.

Each data key is bound to its workspace as AES-GCM additional authenticated data, so a
ciphertext copied into another tenant's row fails to open rather than decrypting.

**With `KMS_PROVIDER=gcp-kms`, KMS is a hard runtime dependency.** If it is unreachable
and the workspace key is not cached, credential resolution **fails closed** — the node
fails with `connection_invalid` rather than guessing. `KEK_CACHE_TTL_MS` is the lever
between KMS load and how quickly a destroyed key stops working. Cloud credentials are
read from the ambient environment only.

### Migrating existing secrets

Secrets written before this phase carry `enc_version = 0` and are still readable. A SQL
migration cannot convert them, because the old keys live in the application environment
rather than the database, so the backfill is a command:

```bash
pnpm --filter @xperiment/cli exec tsx src/main.ts rekey
```

It is resumable, idempotent and safe to run against live traffic; interrupting it leaves
a mixed state both read paths handle. **Keep `TRIGGER_SECRET_KEY` and
`CREDENTIALS_SECRET_KEY` configured until it reports `remaining=0` on all four columns** —
it exits non-zero while any row is left.

### Account recovery (AUTH-002)

Registration mails a verification link and records `auth.email_verify_requested`;
`GET /v1/auth/me` reports `emailVerified`. **Verification currently gates nothing** — an
unconfirmed address sees a banner and keeps full access. Treat it as a signal, not a
control.

`POST /v1/auth/forgot-password` answers `200` for every syntactically valid address,
whether or not an account exists, so it cannot be used to enumerate members. Every token
failure — unknown, expired, already used, or presented to the wrong endpoint — returns the
same `400 Invalid or expired token`, since distinguishing them would say which of a stolen
batch is still live. Tokens are stored as hashes and consumed with a compare-and-set, so
concurrent callers cannot both claim one.

**A completed reset revokes every session** for that user and burns their other outstanding
reset links: a stolen session must not survive the reset that was meant to end it.

`MAIL_TRANSPORT=log` writes the message — including the reset link — to the server log and
sends nothing. It is the development default and **must never run in production.**

### Two-factor authentication (AUTH-004)

Any user may enable a TOTP second factor from `/security`. The secret is wrapped by the
deployment **root key** rather than a workspace KEK, because MFA is account-level: filing it
under one workspace would mean destroying that workspace's key locks the user out of every
other workspace they belong to. Under `KMS_PROVIDER=gcp-kms` that means **one KMS decrypt per
MFA login** — human login rates, not request rates.

Login becomes two steps once a factor is confirmed: the password answers with a five-minute
challenge instead of a session, and `POST /v1/auth/mfa/verify` trades that challenge plus a
code for the session. A wrong code does not burn the challenge; running out of attempts
does. **A password reset does not bypass the second factor.**

Codes are single use: the verification window is ±1 step, so a code is live for 90 seconds,
and `user_mfa.last_used_step` is the floor that stops that window from doubling as a replay
window.

**Both enrolment steps re-authenticate by password.** A bearer token alone must not attach a
factor: a stolen session could otherwise enrol one, and because a password reset revokes
sessions but leaves MFA standing, the real owner would reset, sign in, and be challenged for a
code only the attacker holds — with no owner-initiated reset, a permanent takeover. The
re-authentication is rate limited per user so it cannot become a password oracle.

**Guessing is capped per account, not per challenge.** Whoever holds the password can ask for
as many challenges as they like, so a per-challenge budget bounds nothing. Login no longer
clears its own limiter when a second factor is pending — only a login that ends in a session
does — and `/v1/auth/mfa/verify` counts failures against the account.

`disable` is refused with `409` while the caller holds a privileged role in any workspace that
requires the factor, and the MFA policy route is session-only: an API key carrying the owner
role must not be able to switch off the very policy it is exempt from.

Ten single-use recovery codes are issued at enrolment and shown **once**. They are the only
way back in without the authenticator — an owner cannot reset a member's factor.

An owner may require the factor of every owner and admin in a workspace
(`PUT /v1/workspaces/mfa-policy`). Turning it on requires the owner to be enrolled already.
While the policy is unmet, a privileged member gets `403 MFA required` on everything except
`/v1/auth/me`, `/v1/auth/mfa/*` and `/v1/auth/logout`, so the account can always be fixed.

**The policy does not cover API keys.** A key is not a human and cannot present a code, so
enforcing it against keys would break every running automation the moment the switch is
flipped. A key carrying the admin role keeps full access under the policy; revoking the key
is the control that applies.

### Audit trail

`audit_events` records credential lifecycle (`credential.create`, `.delete`, `.test`),
credential use by a workflow node (`credential.read_use`, one row per node), signing
secret disclosure (`trigger_secret.reveal`), the backfill (`secret.rekey_batch`),
authentication (`auth.register`, `.login_failed`, `.login_succeeded`, `.logout`,
`.logout_all`), account recovery (`auth.email_verify_requested`, `.email_verified`,
`.password_reset_requested`, `.password_reset_completed`), the second factor
(`auth.mfa_enabled`, `.mfa_disabled`, `.mfa_challenged`, `.mfa_verified`, `.mfa_failed`,
`.mfa_recovery_used`, `.mfa_recovery_regenerated`) and privileged workspace changes
(`workspace.create`, `member.role_change`, `invite.create`, `invite.accept`,
`api_key.create`, `api_key.revoke`, `plan.change`, `invoice.pay`, `invoice.mark_paid`,
`workspace.mfa_policy_change`).
Events describing a mutation commit inside that mutation's transaction. Metadata is a fixed
set of named scalars, never a request body, provider response, or token.

Read it with `GET /v1/audit`, which requires the `audit:read` permission — **admin and
owner only**, since seeing every member's credential use is itself a privilege. Rows with
no workspace (a failed login for an unrecognised email) are never returned. `auth_events`
is retained as historical data and receives no further writes.

## Layout

```text
packages/  ir | expressions | engine-core | connectors | db | queue | ai
apps/      api (3000) | orchestrator (3001) | worker (3002) | gateway (3003) | scheduler (3004) | web (3005) | cli
e2e/       end-to-end scenario suite
```
