# Phase 3 Sub-project O — Invoices & Payment Adapter

**Status:** Approved (design gate 2026-07-28)
**PRD:** BILL-005 (invoice dan payment provider integration)
**Depends on:** Phase 2I (`usage_events` ledger), Phase 3M (`billing:read` / `billing:manage`), Phase 3N (`workspace_plans`, `workspace_usage_counters`, `PLAN_CATALOG`, `evaluateQuota`)

## Goal

Turn the entitlement state N built into money: close each billing period into an
immutable invoice, and give that invoice a payment lifecycle behind a provider
interface that a real gateway can implement later without touching the invoice engine.

## Scope boundary

PRD §16.3 "Payment Reconciliation Pack" (Midtrans/DOKU webhook verification, refund
approval, reconciliation report) is a **customer-facing vertical pack** — connectors and
templates for our users' own payments, alongside CON-011. It is not this slice. O is
Xperiment billing **its own customers** for plan subscription and overage.

**Out of scope, deliberately:** dunning and retry schedules, refunds, credit notes,
proration, multi-currency, faktur pajak e-filing, and any real gateway adapter.

## Decisions taken at the design gate

| Question | Decision |
|---|---|
| Provider depth | A `PaymentProvider` interface plus one real provider, `manual` (bank transfer / VA reference, settled by an admin). A Midtrans or Xendit adapter drops in behind the same interface later. |
| Mid-period plan change | Charge the plan active **at period close**, with plan changes recorded in an audit trail so a later slice can add proration without having lost the history. |
| Tax | A configurable rate stored per invoice, defaulting to 11% (Indonesian PPN). |

**Tax caveat, carried into the README:** the 11% default is a placeholder. A live
deployment needs real tax advice — the code asserts no legal position, it only records
whatever rate it was configured with.

## Money representation

All amounts are **integer IDR**, named `*_minor` for forward compatibility with
currencies that have subunits. Rupiah has no practical subunit, so an integer is exact.
No floating-point value ever reaches an amount: DB columns are `BIGINT`, TypeScript
values are `number` constrained to integers, and a test asserts every persisted amount
satisfies `Number.isInteger`.

Tax is `Math.round(subtotal * taxRateBps / 10_000)` — computed **once**, at issue, and
stored. It is never recomputed from a rate that may since have changed.

## Architecture

### `packages/plans` gains prices and a pure invoice builder

Prices sit beside the limits they meter, in the same pure package:

```ts
export interface PlanPricing {
  monthlyPriceMinor: number;
  overagePerExecutionMinor: number;
  overagePer1kAiTokensMinor: number;
}

export const PLAN_PRICING: Record<PlanCode, PlanPricing> = {
  free:     { monthlyPriceMinor: 0,         overagePerExecutionMinor: 0,   overagePer1kAiTokensMinor: 0 },
  builder:  { monthlyPriceMinor: 149_000,   overagePerExecutionMinor: 25,  overagePer1kAiTokensMinor: 150 },
  team:     { monthlyPriceMinor: 599_000,   overagePerExecutionMinor: 20,  overagePer1kAiTokensMinor: 120 },
  business: { monthlyPriceMinor: 2_499_000, overagePerExecutionMinor: 0,   overagePer1kAiTokensMinor: 0 },
};

export const DEFAULT_TAX_RATE_BPS = 1100; // 11% — placeholder, see the tax caveat
export const CURRENCY = 'IDR';
```

`free` prices at zero, so a free workspace still gets a zero invoice — one uniform code
path, and the invoice history is complete from day one. `business` is unlimited on every
metric, so its overage rates are unreachable and set to zero rather than to a number that
implies a charge that can never occur.

`packages/plans/src/invoice.ts` is pure, with no I/O:

```ts
export type InvoiceLineKind = 'subscription' | 'overage_execution' | 'overage_ai_tokens';

export interface InvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
}

export interface InvoiceDraft {
  lines: InvoiceLine[];
  subtotalMinor: number;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
}

export function buildInvoice(args: {
  planCode: PlanCode;
  limits: PlanLimits;
  usage: Record<LimitKey, number>;
  taxRateBps: number;
}): InvoiceDraft;
```

Rules, in order:

1. Always emit exactly one `subscription` line at the plan's `monthlyPriceMinor`,
   quantity 1 — even at zero, so every invoice has at least one line.
2. For each metered flow limit, `overageQuantity = max(0, used - limit)`. A `null`
   (unlimited) limit yields **no line at all**, not a zero line — unlimited means the
   metric is not billed, which is different from being billed nothing.
3. Emit an overage line only when the quantity is positive.
4. AI-token overage bills per 1,000 tokens, rounded **up** (`Math.ceil(qty / 1000)`), so
   a partial thousand is a whole billable unit. The line's `quantity` is the number of
   1k units, and its description names the raw token count.
5. `subtotalMinor` is the sum of line amounts; `taxMinor` and `totalMinor` follow.

Stock limits (`activeWorkflows`, `members`) are **not** billed as overage: they are
enforced as hard caps at their gates, so a workspace can never exceed them and an
overage line would always be zero. Billing them would be dead code that implies a
policy that does not exist.

### Migration 0011

```sql
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  plan_code       TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'IDR',
  subtotal_minor  BIGINT NOT NULL,
  tax_rate_bps    INTEGER NOT NULL,
  tax_minor       BIGINT NOT NULL,
  total_minor     BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'issued',
  provider        TEXT NULL,
  provider_ref    TEXT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ NULL,
  CONSTRAINT invoices_status_check CHECK (status IN ('issued','paid','void')),
  CONSTRAINT invoices_period_unique UNIQUE (workspace_id, period_start)
);

CREATE TABLE invoice_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  description      TEXT NOT NULL,
  quantity         BIGINT NOT NULL,
  unit_price_minor BIGINT NOT NULL,
  amount_minor     BIGINT NOT NULL
);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX idx_invoices_workspace ON invoices (workspace_id, period_start DESC);
```

`UNIQUE (workspace_id, period_start)` is the load-bearing constraint: it makes the close
sweep idempotent **by construction** rather than by the sweep being careful. Two
scheduler instances racing produce one invoice and a `23505` the loser catches and skips.

There is no `draft` status. An invoice comes into existence only when its period has
closed and its numbers are final; a mutable pre-invoice would invite exactly the
"recompute the total" bug the immutability is there to prevent.

### `packages/db/src/repos/invoices.ts`

```ts
export interface InvoiceRow { /* the columns above, camelCased */ }
export interface InvoiceLineRow { /* ditto */ }

/** Insert an invoice and its lines atomically. `null` when the period is already invoiced. */
export async function issueInvoice(pool, args: {
  workspaceId: string; periodStart: Date; periodEnd: Date; planCode: PlanCode; draft: InvoiceDraft;
}): Promise<InvoiceRow | null>;

export async function listInvoices(db, workspaceId, limit): Promise<InvoiceRow[]>;
export async function getInvoice(db, id, workspaceId): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null>;

/** CAS: only an `issued` invoice becomes `paid`. Returns false on a replay. */
export async function markInvoicePaid(db, args: { id: string; workspaceId: string; provider: string; providerRef: string }): Promise<boolean>;

/**
 * Workspaces whose closed period has no invoice yet.
 *
 * Excludes any workspace created at or after `periodEnd` — a workspace that did not
 * exist during the period must not receive an invoice for it, and its counters for that
 * period are necessarily absent, so it would otherwise be issued a spurious zero
 * subscription charge for a month it was never a customer.
 */
export async function workspacesNeedingInvoice(
  db,
  args: { periodStart: Date; periodEnd: Date },
): Promise<{ workspaceId: string }[]>;
```

`issueInvoice` returns `null` rather than throwing on the unique violation, so the sweep
treats "already invoiced" as an ordinary outcome. There is no generic `updateInvoice`:
the only mutation the repo exposes is the CAS to `paid`, which is what keeps an issued
invoice immutable in practice and not merely by convention.

### `runInvoiceSweep` in the scheduler

Joins the three existing sweeps in `apps/scheduler/src/main.ts`, with a savepoint per
workspace so one failure cannot roll back the batch — the `runAlertSweep` pattern.

For the **previous** period only (`periodStart(now)` minus one month, via a new
`previousPeriod(now)` helper in `packages/plans`): for each workspace with no invoice for
that period, read its plan and that period's counters, `buildInvoice`, and `issueInvoice`.

It never invoices the current period. A period is billable only once nothing can still
write to it, and the counter rows for a closed month are inert by then.

`period_end` is **exclusive** — the first instant of the following month, matching N's
`periodEnd(start)`. Stored as a `DATE`, an invoice for July 2026 records
`period_start = 2026-07-01`, `period_end = 2026-08-01`.

## Configuration

Three environment variables, each with a working default so a dev instance needs none:

| Variable | Default | Meaning |
|---|---|---|
| `INVOICE_TAX_RATE_BPS` | `1100` (`DEFAULT_TAX_RATE_BPS`) | Rate stamped onto each invoice at issue. Changing it affects only invoices issued afterwards — issued invoices keep the rate they were built with. |
| `PAYMENT_PROVIDER` | `manual` | Which provider `POST /v1/invoices/:id/pay` charges through. An unknown key is a startup failure, not a per-request one, so a typo cannot silently disable payment. |
| `PAYMENT_WEBHOOK_SECRET` | unset | Shared secret handed to `verifyWebhook`. When unset the webhook route returns 401 for every request rather than verifying against an empty string. |

### `PaymentProvider` and the `manual` provider

`packages/payments` — a new pure package, peer to `@xperiment/plans`, so the API and gateway
can both reach it without importing from one another:

```ts
export interface ChargeRequest {
  invoiceId: string;
  workspaceId: string;
  totalMinor: number;
  currency: string;
}

export interface ChargeResult {
  reference: string;
  instructions: string;
}

export interface WebhookVerdict {
  invoiceRef: string;
  status: 'paid' | 'failed';
}

export interface PaymentProvider {
  readonly key: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  /** Null on any failure — signature mismatch, malformed body, unknown event. Fails closed. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, secret: string): WebhookVerdict | null;
}

export const manualProvider: PaymentProvider;
export function providerFor(key: string): PaymentProvider | null;
```

`manual` issues a deterministic bank-transfer reference derived from the invoice id and
returns human instructions; its `verifyWebhook` always returns `null`, because a manual
transfer has no callback — settlement is the admin action below.

`verifyWebhook` returning `null` rather than throwing keeps the intake route's failure
path total: anything it cannot positively verify is a 401 that mutates nothing.

### API

| Route | Permission | Behaviour |
|---|---|---|
| `GET /v1/invoices` | `billing:read` | Recent invoices for the workspace |
| `GET /v1/invoices/:id` | `billing:read` | Invoice with its lines; 404 cross-tenant |
| `POST /v1/invoices/:id/pay` | `billing:manage` | `createCharge` with the configured provider; stores `provider`/`provider_ref`; returns the reference and instructions |
| `POST /v1/invoices/:id/mark-paid` | `billing:manage` | The manual settlement path; CAS `issued → paid`, 409 on replay |
| `POST /v1/payments/:provider/webhook` | none (signed) | Verifies via `providerFor(provider)`, applies the verdict through the same CAS; 401 on any verification failure |

These are the second and third routes for the billing permissions, so `rbac.test.ts`
gains matrix rows for each; `UNROUTED` stays empty.

The webhook route lives on the API rather than the gateway: the gateway's job is
customer webhook *ingress into workflows*, and mixing Xperiment's own billing callbacks into
that surface would blur a boundary that is currently clean.

### Web

The `/plan` page gains an invoices table — period, plan, total, status, and a settle
action for an `issued` invoice when the viewer holds `billing:manage`. A 403 renders
`PermissionNotice`, per M's convention, and every new query sets `retry: false` so a
refused read never renders as an empty list.

## Error handling

- The sweep is savepoint-per-workspace; a failure is logged with the workspace id and
  the batch continues.
- `issueInvoice` maps `23505` to `null`; every other SQLSTATE propagates.
- `markInvoicePaid` is a CAS, so a replayed webhook or a double-clicked button is a
  no-op returning `false` — the route maps that to 409, never to a second payment.
- A webhook that fails verification returns 401 having touched nothing, and the failure
  is logged **without** the raw body, which may carry provider secrets.
- Amounts are integers throughout; a non-integer would be a programming error, and the
  invoice builder's tests pin the rounding rather than leaving it to chance.

## Testing

- **Pure (`packages/plans`):** `buildInvoice` with no overage, usage exactly at the
  limit, one over, an unlimited plan (no overage lines emitted), a partial AI-token
  thousand rounding up, a zero-priced free plan, and tax rounding at a half-unit
  boundary.
- **Pure (`packages/payments`):** `manual` reference determinism; `verifyWebhook`
  returning null for a bad signature, a malformed body, and an unknown provider key.
- **DB:** `issueInvoice` writes lines atomically; a second call for the same period
  returns `null`; **a concurrent double-issue via `Promise.all` produces exactly one
  invoice** — written in parallel, because a sequential version of that test passes
  against a broken guard, which is what the last two slices proved twice over.
  `markInvoicePaid` CAS returns false on replay; `getInvoice` is tenant-scoped.
- **API:** an RBAC matrix row per new route; cross-tenant 404; mark-paid replay 409;
  webhook 401 on a bad signature.
- **E2E:** seed a closed period with usage past the cap, run the sweep, assert the
  invoice total equals subscription + overage + tax, settle it, and assert `paid`.

Coverage stays ≥80% on all four metrics for every package.
