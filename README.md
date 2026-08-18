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
pnpm dev
```

`pnpm dev` starts all six services in one terminal — api (3000), orchestrator
(3001), worker (3002), gateway (3003), scheduler (3004) and web (3005) — and
Ctrl-C stops them. Migrations run at boot behind a Postgres advisory lock, so
starting six services at once serialises rather than races and `pnpm migrate` is
not a separate step.

It reads a root `.env` if you have one, but the real environment always wins: a
CI job that exported `DATABASE_URL` must not be overridden by a file somebody
left in their checkout. If Postgres or Redis is unreachable it says which one and
stops, instead of printing five interleaved connection stack traces.

Ports come from `API_PORT`, `ORCH_PORT`, `WORKER_PORT`, `GATEWAY_PORT`,
`SCHEDULER_PORT` and `WEB_PORT`. Two services pointed at one port is refused
before anything starts, as is any port in 3100-3104 or 3311-3312 — the e2e suites
force-kill whatever owns those at the start and end of every run.

To run one service on its own:

```bash
pnpm --filter @xperiment/api dev
```

### Without a Node toolchain

Everything, in containers:

```bash
docker compose --profile app up -d --build
```

`docker compose up -d` without the profile still starts only Postgres and Redis,
because that is what `pnpm dev` and both e2e helpers assume.

The image ships TypeScript source and runs it with `tsx`. That is deliberate:
`tsconfig.base.json` sets `noEmit` and sixteen of eighteen manifests point `main`
at a `.ts` file, so adding a compile step for containers alone would create a
second code path that only containers take. `apps/web` is the one exception —
Next has a real build.

Use this to run the stack, not to write code: the containers have no live reload
and rebuild on every source change. `NEXT_PUBLIC_API_URL` is inlined into the
client bundle at build time, so serving the web app from a different hostname
needs a rebuild, not a restart.

Postgres now keeps a named volume, so `docker compose down` no longer discards
the database. `docker compose down -v` still wipes it.

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
   (`parameters: { authMode: 'none'|'token'|'hmac'|'meta'|'xendit'|'midtrans', idempotencyKeyPath?: 'event.id' }`)
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

### Receiving from a provider

`hmac` and `token` are Xperiment's own schemes. The other three exist because each provider
dictates exactly one, and none of them matches:

| `authMode` | What arrives | Verified against |
|---|---|---|
| `meta` | `X-Hub-Signature-256: sha256=<hex>` | HMAC-SHA256 over the raw body |
| `xendit` | `x-callback-token: <token>` | Constant-time compare with the secret |
| `midtrans` | `signature_key` **inside** the JSON body | `sha512(order_id + status_code + gross_amount + secret)` |

Midtrans concatenates the three fields as the **exact strings it sent**. Parsing
`gross_amount` `"56000.00"` into a number and re-formatting it produces a different
digest and rejects every genuine callback — that is the usual way this integration
fails.

An `authMode` nobody implemented fails closed. A typo cannot read as "no auth needed".

### When a webhook does not arrive

Every delivery to a **known** route key is recorded, accepted or not:
`GET /v1/workflows/:id/deliveries`, and in the editor under **Recent deliveries**
on the trigger panel. Before this a rejected delivery produced a 401 and nothing
else, so "my webhook isn't working" had no evidence anywhere in the product.

The row that matters most reads: *sent `x-xperiment-signature`, but this trigger
expects `x-hub-signature-256`* — the wrong-header mistake the table above exists
to make possible in the first place.

Three things are deliberately **not** stored:

- **The body.** A rejected delivery is unauthenticated input; keeping it would let
  anyone holding a route key write arbitrary content into the database and onto an
  operator's screen. Only its size is recorded.
- **Header values.** Only header *names*, from a fixed diagnostic allowlist — those
  values are the signatures and bearer tokens.
- **Anything at all for an unknown route key.** Otherwise a public endpoint lets
  anyone fill the table by spraying random keys.

Because there is no body and no header value, this is readable by any member with
`execution:read`, including a viewer — unlike sample payloads, which are customer
data and need `execution:run`. Deliveries are pruned on the same horizon as the
trigger bodies they describe.

**Meta subscription handshake.** Meta subscribes with
`GET /t/:routeKey?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` and requires
the challenge echoed back as plain text. Xperiment answers that on `GET`, and the handler is
deliberately separate from the POST path with two properties:

- **A `GET` can never start an execution.** Webhook URLs get pasted into chat apps that
  fetch them automatically; a `GET` that ran a workflow would fire on any crawler or link
  preview that touched the URL.
- **Every failure is `404`, never `401`** — byte-identical to an unknown route key.
  A distinguishable failure would let someone sweep route keys and learn which ones exist
  without ever authenticating. A trigger with no secret can never complete a handshake,
  and the challenge must match `[A-Za-z0-9_-]{1,256}` so the endpoint cannot be used to
  reflect arbitrary content.

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

`slack.postMessage`, `midtrans.createTransaction` and `xendit.createInvoice` join them.
Three provider behaviours are worth knowing, because each is a way to be wrong quietly:

- **Slack answers HTTP 200 with `{ ok: false }`.** A revoked token or a channel the bot
  was removed from arrives as a *successful* response. The connector checks `ok`, so
  those become node failures instead of messages nobody received.
- **Midtrans returns 406 for a duplicate `orderId`; Xendit returns 409 for a duplicate
  `externalId`.** Both are re-thrown as non-retryable errors *without* an HTTP status,
  because the worker's classifier overrides a connector's retryable flag for anything
  carrying one. Left alone, a duplicate order would be retried three times against a
  provider that will keep refusing it.
- **Midtrans has no `Test` button, on purpose.** Snap offers no side-effect-free
  credential probe, and inventing one by posting a throwaway transaction would leave real
  orders in a real merchant dashboard. Xendit's test reads `/balance`, which is genuinely
  read-only.

Midtrans defaults to the **sandbox** host. A misconfigured connection that reaches sandbox
costs nothing; the same mistake against production creates a real payment page for a real
customer. Production is one explicit `baseUrl` away.

Amounts on both payment connectors are whole rupiah — IDR has no minor unit. When
`itemDetails` is supplied, Midtrans requires `grossAmount` to equal the sum of
`price × quantity`; the connector checks that before making any request, so the error names
the actual problem instead of relaying a generic 400.

1. `POST /v1/connections` with `{ connectorKey, name, payload }` — payloads are
   validated per connector, AES-256-GCM encrypted at rest, and never returned by the
   API. `POST /v1/connections/:id/test` verifies against the provider.
2. Reference the connection from a node via `connectionRef: "<connection id>"` in the
   IR. Publish fails with `connection_required` / `connection_not_found` /
   `connection_wrong_type` findings until every credentialed node resolves.
3. The worker decrypts just-in-time and passes the payload in memory only — it never
   appears in stored inputs, events, or logs. Provider `baseUrl` overrides in the
   payload support stubbed testing.

### Rotating a credential

Provider tokens expire. `PUT /v1/connections/:id` replaces the stored payload and
**keeps the id**, so every published version that names the connection keeps
working. Without it the only route was: create a second connection, hand-edit
`connectionRef` on every node, republish each workflow, then delete the old one —
and `DELETE` refuses with 409 while any published version still references it.

Two deliberate constraints:

- **Whole replacement, not a merge.** The stored payload is write-only and never
  returned, so the form cannot prefill it. A partial update would let someone
  submit only the token they came to rotate and keep stale values for everything
  else, and the mismatch would surface as a failed production run rather than a
  failed save. Every required field must be sent.
- **`connectorKey` is immutable.** It is read from the stored row, never from the
  request. Repointing a connection at a different connector would leave published
  nodes calling something whose payload no longer matches.

The form fields come from `GET /v1/connectors`, which publishes each connection
type's JSON Schema alongside the node catalog. The web app derives inputs from it
rather than keeping its own copy — the copy it used to keep had already lost
`smtp.secure`, `googleSheets.baseUrl` and `googleSheets.tokenUrl`. A field name the
UI does not recognise renders masked, so an unfamiliar credential is never shown in
plain text by default.

### Finding a failed run

`GET /v1/executions?status=FAILED,TIMED_OUT` filters on the server. The web list
used to fetch the default twenty rows and filter them in the browser, so choosing
FAILED showed "No executions" whenever the last twenty runs had succeeded — while
the failures sat unreachable on page two. On a five-minute cron, twenty rows is a
hundred minutes of history.

The filter lives in the URL, so a filtered view is a link somebody can send.

Pagination is keyset (`created_at, id`), and **a cursor is only valid for the
filter it was issued under**. A cursor is just a position: handed to a request
with a different filter it would return the page of rows after that position from
the wrong set — no error, no empty result, silently wrong. The filter is hashed
into the cursor and a mismatch is a 400.

### Finding the run for one order

"The customer says order INV-20260811-0042 never went through." Status filtering
does not help — the run is probably SUCCEEDED, sitting among four hundred others.
`GET /v1/executions/search?q=…` matches a substring of the webhook body that
started each run, and the executions page has a search box for it.

Backed by a **pg_trgm GIN index** on the payload text, because the question is
always a substring — an order id, a phone number, an email — and never a JSON path
the operator knows. That requires the `pg_trgm` extension; migration 0021 creates
it, and a database that forbids it fails at migration time rather than silently
sequential-scanning later.

**The three-character minimum is measured, not stylistic.** A trigram is three
consecutive characters. At two characters `show_trgm` returns only *padded*
trigrams (`"  9"`, `" 99"`, `"99 "`), and padding only matches at a word boundary
— so an infix search has nothing to look up and Postgres reads every webhook body
in the table. Shorter queries are a 400.

Two safety properties:

- **Gated on `execution:run`**, the same permission as reading a node payload. A
  viewer is a read-only observer; substring-probing customer data would turn
  `execution:read` into a transitive read of every webhook body.
- **Results carry no payload content** — execution id, workflow, status, time. The
  caller could open one and see it, but a list view left open on a shared screen
  should not be showing customer data it was never asked for.

`%` and `_` in a query are escaped, so searching `50%` finds the text "50%" rather
than everything after "50", and a query of `%%%` matches nothing rather than
everything.

### Re-running a batch of failures

A provider token expires, forty runs fail over a weekend, somebody rotates the
credential on Monday. `POST /v1/executions/retry` takes those forty back without
opening forty tabs — and on the executions page the filter you are already
looking at *is* the retry filter, so there is no second chance to get it wrong.

Three constraints, because a bulk re-run spends real money and real rate limit:

- **`dryRun` first.** The count is what a person needs before committing, and it
  costs one query. The UI's **Count matches** button does exactly this.
- **Capped per call** (100, default 25). An unbounded "retry everything" is a way
  to replay a month of work with one click.
- **Stops at the first quota refusal and reports the partial.** Quietly doing 43
  of 100 and answering 200 would be a lie the operator discovers from the invoice.

`status` defaults to `FAILED, TIMED_OUT` and cannot be empty — re-running a
success duplicates work that already happened. One audit row (`execution.retry_batch`)
covers the whole batch, not one per run: per-run rows would bury the fact that a
human did this once, deliberately.

One measured detail shapes the query, and it is about **ordering**, not index use.
`status = ANY('{FAILED}')` *does* use the status index — but as a Bitmap Index
Scan, which cannot emit rows in index order, so Postgres sorts the whole matching
set before taking twenty. Scalar `status = 'FAILED'` gets a plain Index Scan
already ordered by `(created_at DESC, id DESC)`, so the page reads twenty-one
index entries and stops. A single-status request is therefore emitted as scalar
equality.

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
- **OpenAPI** — `GET /v1/openapi.json` (public) documents the `/v1` surface. A test
  enumerates every registered route and asserts the document covers it, and that
  nothing in the document is missing from the server. It found twenty-five
  undocumented routes the first time it ran, including the whole account-recovery
  and MFA surface. Adding a route without documenting it now fails the suite.

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

### Billing periods are Asia/Jakarta

A billing period is the **Asia/Jakarta calendar month**, not the UTC one, because the
product schedules in WIB and a shop owner counting their own August orders must agree
with the invoice.

`@xperiment/plans` exposes it as a value with three fields, because one `Date` was previously
doing two different jobs:

```ts
billingPeriod(new Date()) // { key: '2026-08-01', endKey: '2026-09-01',
                          //   startsAt: 2026-07-31T17:00Z, endsAt: 2026-08-31T17:00Z }
```

`key` is the DATE label of `workspace_usage_counters.period_start` and
`invoices.period_start`; `startsAt`/`endsAt` are the instants a `timestamptz` is compared
against. In SQL the bounds are always built from the key in the zone:

```sql
occurred_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Jakarta')
occurred_at <  (($1::date + INTERVAL '1 month') AT TIME ZONE 'Asia/Jakarta')
```

never `occurred_at >= $1::date`, which casts through the **session** `TimeZone` — that
made the boundary of a billing period a database setting rather than an application
decision, and on a UTC session it filed a run at 03:00 WIB on the 1st into the previous
month. The daily series on `GET /v1/usage` groups the same way, so the chart shows the
days the shop actually keeps.

**Migration `0022_billing_period_wib.sql`** recomputes the counters from the
`usage_events` ledger — a rekey would not do, because misfiled runs are in the wrong
month, not merely under the wrong label. It rebuilds only what the ledger can still
account for: retention prunes `usage_events` after a 365-day floor, so months older than
a workspace's earliest surviving event keep their UTC-derived values rather than being
silently zeroed. The horizon reaches one month further back than that earliest event,
which is exactly how far the old bounds could misfile.

**Invoices already issued are left as they are.** Their period labels are the right
calendar months; only the amounts came from UTC-bounded counters, and rewriting a closed
invoice changes a record of money. The close sweep is idempotent per
`(workspace_id, period_start)` and will not re-issue them.

Making the zone per-workspace is a real feature with its own settings surface and
migration, and is deliberately not part of this.

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

## Export & import a workflow

A workflow you built is a file you can keep. **Export** on the editor toolbar downloads
`<name>.xperiment.json`; **Import** on the workflows list creates a new workflow from one.

```bash
curl -H "Authorization: Bearer $XPERIMENT_TOKEN" \
  "$API/v1/workflows/$WF_ID/export" -o pesanan-baru.xperiment.json
curl -X POST -H "Authorization: Bearer $XPERIMENT_TOKEN" -H 'content-type: application/json' \
  --data @pesanan-baru.xperiment.json "$API/v1/workflows/import"
```

- `GET /v1/workflows/:id/export` (`workflow:read`) exports the **draft**. Add
  `?version=<versionId>` to export a published version instead — useful when the draft
  is mid-edit, which is a 422 rather than a half-written file.
- `POST /v1/workflows/import` (`workflow:write`) creates a **draft**, never a published
  version. Add `overrideName` to name it something else here. Importing a file must not
  put a workflow live; publishing stays a decision.
- Both are recorded in the audit log as `workflow.export` / `workflow.import`.

**The document carries no secrets.** Connection payloads and trigger secrets are separate
rows and were never part of a definition. What a definition *does* carry is
`connectionRef` — a UUID meaningful only in the workspace it came from. So the export
also lists, in words, which connector each of those nodes needed:

```json
{ "xperimentExport": 1, "name": "Pesanan baru", "definition": { ... },
  "requiredConnections": [{ "nodeId": "notify", "connectorKey": "telegram", "wasConnected": true }] }
```

On import each reference is **kept** when it resolves to a connection of the *same
connector* in the receiving workspace — which makes importing into the same workspace a
fully wired duplicate — and otherwise **stripped and reported** in `reconnect`. Stripping
rather than leaving a foreign UUID dangling is the deliberate half: a surviving reference
would fail later at publish as `connection_not_found` on a node nobody was told about,
whereas removing it produces `connection_required` on exactly the nodes the import already
named. The two answers agree.

The connector is re-derived from the registry, not trusted from the file, so a document
claiming a node needs `postgres` cannot make the import wire it a `telegram` credential.

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

## Data-shaping nodes

Eight logic nodes work on the arrays a trigger or a query hands you. All are pure —
no connection, no network, deterministic output.

| Node | Does | Ports |
|---|---|---|
| `core.switch` | Routes on strict equality against up to ten cases | `case1`…`case10`, `default` |
| `core.filter` | Keeps rows matching a field predicate | `main`, `empty` |
| `core.sort` | Orders by a field | `main` |
| `core.limit` | Takes the first N | `main` |
| `core.aggregate` | sum / avg / min / max / count, optionally grouped | `main` |
| `core.splitBatch` | Chunks a list into batches | `main`, `empty` |
| `core.merge` | Fans several branches back into one | `main` |
| `core.stopAndError` | Ends the run with the author's own error | *(none)* |

Five decisions are worth knowing before you rely on them, because each one is a
place where the obvious behaviour would be wrong:

- **`core.switch` matches strictly.** `150` does not match `"150"`. A webhook that
  sends numbers as strings will fall to `default`, which is visible, rather than
  matching by coincidence.
- **`core.filter` drops rows it cannot compare; it does not fail the run.** A
  relational test against a null field excludes that row. Filtering five thousand
  rows should not die because one of them is missing a price — discarding rows that
  do not meet the condition is the node's whole job.
- **`core.sort` puts nulls last in *both* directions**, and compares strings by
  UTF-16 code unit rather than `localeCompare` — so `'Z' < 'a'`. Locale order shifts
  with the ICU version, which would break the determinism criterion. Null means "no
  data", and burying it at both ends is what "highest price first" actually means.
- **`core.aggregate` reports what it skipped.** Only finite numbers are counted;
  everything else is excluded *and* tallied in `skipped`, so a wrong total cannot
  pass silently. `sum` of nothing is `0`, but `avg`, `min` and `max` of nothing are
  `null` — there is no honest number for the average of nothing, and `0` is a lie
  that ends up on an invoice.
- **`core.merge` treats `null` as "that branch did not run"** and drops it by
  default. A skipped branch is absent from the context, so `{{ nodes.a.output }}`
  resolves to null — which is exactly the signal you want after a `core.if`.

`core.splitBatch` emits the whole list of batches at once rather than one batch per
call: a cursor would need mutable per-execution state *and* a back edge, and
`validateGraph` rejects cycles outright. Feed the batches to `core.loop`
(`items: {{ nodes.split.output.batches }}`) and each `loop.item` is one batch. Note
that `core.loop` defaults to 100 iterations, so 300 batches fails with
`too_many_iterations` — correct, but worth knowing before it surprises you.

`core.stopAndError` declares **no output ports**, so publish rejects any non-`error`
edge leaving it. Under an `onError: 'continue'` policy it would silently not stop the
run, so publish rejects that too (`stop_node_cannot_continue`). Author-supplied
`details` are wrapped rather than passed through — a `httpStatus` key would otherwise
be read by the worker's classifier and make the stop retryable.

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

`audit_events` records bulk re-runs (`execution.retry_batch`), credential lifecycle
(`credential.create`, `.rotate`, `.delete`, `.test`),
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
