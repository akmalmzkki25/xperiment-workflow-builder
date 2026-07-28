# Invoices & Payment Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close each billing period into an immutable invoice and give it a payment lifecycle behind a provider interface a real gateway can implement later.

**Architecture:** Pricing and invoice arithmetic are pure functions in `@xperiment/plans`; the payment provider contract and its one `manual` implementation are a new pure `@xperiment/payments`. Invoices are immutable rows whose `UNIQUE (workspace_id, period_start)` makes the monthly close sweep idempotent by construction. Settlement is a compare-and-set from `issued` to `paid`, so a replayed webhook or a double-clicked button is a no-op.

**Tech Stack:** pnpm workspaces, TypeScript strict + `noUncheckedIndexedAccess`, tsx (runs TS source, no build), Vitest + v8 coverage, Fastify, Next.js 14 App Router, node-postgres.

## Global Constraints

- Coverage thresholds are 80% on lines, statements, functions **and** branches, per package.
- **All money is integer IDR** in `*_minor` fields. No float ever reaches an amount; DB columns are `BIGINT`.
- Tax is `Math.round(subtotal * taxRateBps / 10_000)`, computed once at issue and stored — never recomputed.
- `period_end` is **exclusive**: the first instant of the following month.
- Never hardcode secrets; never log a raw webhook body (it may carry provider secrets).
- No `console.log`. Services use `deps.log`; Fastify routes use `req.log` / `reply.log`.
- Conventional commits, `<type>: <description>`, **no attribution trailer**.
- Fail closed: an unverifiable webhook mutates nothing and returns 401.
- Postgres and Redis run in Docker containers named `postgres` and `redis`. Run `docker start postgres redis` before any db or e2e task.

---

## File Structure

**Create**
- `packages/plans/src/invoice.ts` — pricing table, `buildInvoice`, `previousPeriod`
- `packages/plans/test/invoice.test.ts`
- `packages/payments/{package.json,tsconfig.json,vitest.config.ts}` — new pure package
- `packages/payments/src/index.ts` — `PaymentProvider`, `manualProvider`, `providerFor`
- `packages/payments/test/manual.test.ts`
- `packages/db/src/migrations/0011_invoices.sql`
- `packages/db/src/repos/invoices.ts`
- `packages/db/test/invoices.test.ts`
- `apps/scheduler/src/invoiceSweep.ts`
- `apps/api/src/routes/invoices.ts`
- `apps/api/test/invoices.test.ts`
- `apps/web/src/components/plan/InvoiceTable.tsx`

**Modify**
- `packages/plans/src/index.ts` — re-export the invoice module
- `packages/db/src/index.ts` — export the invoices repo
- `apps/scheduler/src/main.ts` — add the sweep to the `Promise.all`
- `apps/api/src/server.ts`, `apps/api/src/routes/deps.ts`, `apps/api/src/openapi.ts`
- `apps/api/test/rbac.test.ts` — matrix rows for the four gated routes
- `apps/web/src/lib/api.ts`, `apps/web/src/app/(app)/plan/page.tsx`, `apps/web/test/api.test.ts`
- `e2e/test/acceptance.test.ts`, `README.md`, `.env.example`

---

### Task O-1: Pricing and the pure invoice builder

**Files:**
- Create: `packages/plans/src/invoice.ts`, `packages/plans/test/invoice.test.ts`
- Modify: `packages/plans/src/index.ts`

**Interfaces:**
- Consumes: `PlanCode`, `PlanLimits`, `LimitKey`, `LIMIT_KEYS`, `periodStart` from `packages/plans/src/index.ts`.
- Produces: `PlanPricing`, `PLAN_PRICING`, `DEFAULT_TAX_RATE_BPS`, `CURRENCY`, `InvoiceLineKind`, `InvoiceLine`, `InvoiceDraft`, `buildInvoice(args)`, `previousPeriod(now)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/plans/test/invoice.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  buildInvoice,
  CURRENCY,
  DEFAULT_TAX_RATE_BPS,
  PLAN_CATALOG,
  PLAN_PRICING,
  previousPeriod,
  resolveLimits,
  type LimitKey,
} from '../src/index.js';

const usage = (over: Partial<Record<LimitKey, number>> = {}): Record<LimitKey, number> => ({
  executionsPerMonth: 0,
  aiTokensPerMonth: 0,
  activeWorkflows: 0,
  members: 0,
  ...over,
});

const invoice = (planCode: 'free' | 'builder' | 'team' | 'business', used: Partial<Record<LimitKey, number>> = {}) =>
  buildInvoice({
    planCode,
    limits: resolveLimits(planCode, {}),
    usage: usage(used),
    taxRateBps: DEFAULT_TAX_RATE_BPS,
  });

describe('PLAN_PRICING', () => {
  test('prices every plan in the catalog with whole rupiah', () => {
    for (const code of Object.keys(PLAN_CATALOG)) {
      const p = PLAN_PRICING[code as keyof typeof PLAN_PRICING];
      expect(p, code).toBeDefined();
      for (const v of Object.values(p)) {
        expect(Number.isInteger(v), `${code} ${v}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('the currency is IDR and the default rate is 11%', () => {
    expect(CURRENCY).toBe('IDR');
    expect(DEFAULT_TAX_RATE_BPS).toBe(1100);
  });
});

describe('buildInvoice', () => {
  test('always emits exactly one subscription line, even on the free plan', () => {
    const free = invoice('free');
    expect(free.lines).toHaveLength(1);
    expect(free.lines[0]).toMatchObject({ kind: 'subscription', quantity: 1, amountMinor: 0 });
    expect(free.totalMinor).toBe(0);
  });

  test('a plan under every limit bills the subscription only', () => {
    const inv = invoice('builder', { executionsPerMonth: 10, aiTokensPerMonth: 100 });
    expect(inv.lines.map((l) => l.kind)).toEqual(['subscription']);
    expect(inv.subtotalMinor).toBe(PLAN_PRICING.builder.monthlyPriceMinor);
  });

  test('usage exactly at the limit is not overage', () => {
    const limit = PLAN_CATALOG.builder.executionsPerMonth!;
    const inv = invoice('builder', { executionsPerMonth: limit });
    expect(inv.lines.map((l) => l.kind)).toEqual(['subscription']);
  });

  test('one execution over the limit bills one unit of overage', () => {
    const limit = PLAN_CATALOG.builder.executionsPerMonth!;
    const inv = invoice('builder', { executionsPerMonth: limit + 1 });
    const line = inv.lines.find((l) => l.kind === 'overage_execution')!;
    expect(line).toMatchObject({ quantity: 1, unitPriceMinor: PLAN_PRICING.builder.overagePerExecutionMinor });
    expect(line.amountMinor).toBe(PLAN_PRICING.builder.overagePerExecutionMinor);
  });

  test('a partial thousand of AI tokens rounds up to a whole billable unit', () => {
    const limit = PLAN_CATALOG.builder.aiTokensPerMonth!;
    const inv = invoice('builder', { aiTokensPerMonth: limit + 1500 });
    const line = inv.lines.find((l) => l.kind === 'overage_ai_tokens')!;
    expect(line.quantity).toBe(2); // ceil(1500 / 1000)
    expect(line.description).toContain('1500');
  });

  test('an unlimited plan emits no overage line at all, however large the usage', () => {
    const inv = invoice('business', { executionsPerMonth: 9_999_999, aiTokensPerMonth: 9_999_999 });
    expect(inv.lines.map((l) => l.kind)).toEqual(['subscription']);
  });

  test('stock limits are never billed as overage', () => {
    const inv = invoice('builder', { members: 999, activeWorkflows: 999 });
    expect(inv.lines.map((l) => l.kind)).toEqual(['subscription']);
  });

  test('subtotal is the sum of the lines and total is subtotal plus tax', () => {
    const limit = PLAN_CATALOG.builder.executionsPerMonth!;
    const inv = invoice('builder', { executionsPerMonth: limit + 100 });
    expect(inv.subtotalMinor).toBe(inv.lines.reduce((s, l) => s + l.amountMinor, 0));
    expect(inv.totalMinor).toBe(inv.subtotalMinor + inv.taxMinor);
  });

  test('tax rounds half up and every amount stays an integer', () => {
    const inv = buildInvoice({
      planCode: 'builder',
      limits: resolveLimits('builder', {}),
      usage: usage(),
      taxRateBps: 1100,
    });
    expect(inv.taxMinor).toBe(Math.round((PLAN_PRICING.builder.monthlyPriceMinor * 1100) / 10_000));
    for (const v of [inv.subtotalMinor, inv.taxMinor, inv.totalMinor]) expect(Number.isInteger(v)).toBe(true);
  });

  test('a zero tax rate produces no tax', () => {
    const inv = buildInvoice({
      planCode: 'team',
      limits: resolveLimits('team', {}),
      usage: usage(),
      taxRateBps: 0,
    });
    expect(inv.taxMinor).toBe(0);
    expect(inv.totalMinor).toBe(inv.subtotalMinor);
  });
});

describe('previousPeriod', () => {
  test('returns the calendar month before the one containing `now`', () => {
    const p = previousPeriod(new Date('2026-07-28T13:45:00Z'));
    expect(p.start.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('rolls the year backwards in January', () => {
    const p = previousPeriod(new Date('2026-01-15T00:00:00Z'));
    expect(p.start.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/plans test`
Expected: FAIL — `buildInvoice is not exported`.

- [ ] **Step 3: Implement the module**

Create `packages/plans/src/invoice.ts`:

```ts
import { type LimitKey, type PlanCode, type PlanLimits } from './index.js';

export interface PlanPricing {
  monthlyPriceMinor: number;
  overagePerExecutionMinor: number;
  overagePer1kAiTokensMinor: number;
}

/**
 * Prices in whole rupiah. Rupiah has no practical subunit, so an integer is exact —
 * the `*Minor` suffix keeps the field names honest for a future currency that does.
 *
 * Placeholders pending the customer discovery PRD §15 defers pricing to. `free` prices
 * at zero so a free workspace still receives a zero invoice through the same code path;
 * `business` is unlimited on every metered limit, so its overage rates are unreachable
 * and set to zero rather than to a number implying a charge that cannot occur.
 */
export const PLAN_PRICING: Record<PlanCode, PlanPricing> = {
  free: { monthlyPriceMinor: 0, overagePerExecutionMinor: 0, overagePer1kAiTokensMinor: 0 },
  builder: { monthlyPriceMinor: 149_000, overagePerExecutionMinor: 25, overagePer1kAiTokensMinor: 150 },
  team: { monthlyPriceMinor: 599_000, overagePerExecutionMinor: 20, overagePer1kAiTokensMinor: 120 },
  business: { monthlyPriceMinor: 2_499_000, overagePerExecutionMinor: 0, overagePer1kAiTokensMinor: 0 },
};

export const CURRENCY = 'IDR';

/** 11%, Indonesian PPN. A placeholder — a live deployment needs real tax advice. */
export const DEFAULT_TAX_RATE_BPS = 1100;

const AI_TOKEN_BILLING_UNIT = 1000;

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

/** Units consumed beyond a limit. `null` (unlimited) is not billed at all. */
function overageOf(limit: number | null, used: number): number {
  return limit === null ? 0 : Math.max(0, used - limit);
}

export function buildInvoice(args: {
  planCode: PlanCode;
  limits: PlanLimits;
  usage: Record<LimitKey, number>;
  taxRateBps: number;
}): InvoiceDraft {
  const pricing = PLAN_PRICING[args.planCode] ?? PLAN_PRICING.free;
  const lines: InvoiceLine[] = [
    {
      kind: 'subscription',
      description: `${args.planCode} plan`,
      quantity: 1,
      unitPriceMinor: pricing.monthlyPriceMinor,
      amountMinor: pricing.monthlyPriceMinor,
    },
  ];

  const execOverage = overageOf(args.limits.executionsPerMonth, args.usage.executionsPerMonth);
  if (execOverage > 0) {
    lines.push({
      kind: 'overage_execution',
      description: `${execOverage} executions beyond the plan limit`,
      quantity: execOverage,
      unitPriceMinor: pricing.overagePerExecutionMinor,
      amountMinor: execOverage * pricing.overagePerExecutionMinor,
    });
  }

  const tokenOverage = overageOf(args.limits.aiTokensPerMonth, args.usage.aiTokensPerMonth);
  if (tokenOverage > 0) {
    // A partial thousand is a whole billable unit.
    const units = Math.ceil(tokenOverage / AI_TOKEN_BILLING_UNIT);
    lines.push({
      kind: 'overage_ai_tokens',
      description: `${tokenOverage} AI tokens beyond the plan limit`,
      quantity: units,
      unitPriceMinor: pricing.overagePer1kAiTokensMinor,
      amountMinor: units * pricing.overagePer1kAiTokensMinor,
    });
  }

  // Stock limits (activeWorkflows, members) are hard caps enforced at their gates, so a
  // workspace can never exceed them — an overage line would always be zero and would
  // imply a policy that does not exist.
  const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
  const taxMinor = Math.round((subtotalMinor * args.taxRateBps) / 10_000);
  return { lines, subtotalMinor, taxRateBps: args.taxRateBps, taxMinor, totalMinor: subtotalMinor + taxMinor };
}

/** The closed calendar month before the one containing `now`. `end` is exclusive. */
export function previousPeriod(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}
```

Append to `packages/plans/src/index.ts`:

```ts
export * from './invoice.js';
```

Note the import cycle is fine here: `invoice.ts` imports types from `index.ts`, and
`index.ts` re-exports `invoice.ts`. TypeScript resolves type-only cycles, and the runtime
values (`PLAN_PRICING`) are defined in `invoice.ts` itself.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/plans test:cov`
Expected: PASS — 14 new tests, coverage 100%.

If the circular import causes a runtime failure, move the three type imports to
`import type { ... } from './index.js'` — type-only imports are erased and cannot cycle.

- [ ] **Step 5: Commit**

```bash
git add packages/plans
git commit -m "feat: add plan pricing and the pure invoice builder"
```

---

### Task O-2: The `@xperiment/payments` provider contract

**Files:**
- Create: `packages/payments/package.json`, `packages/payments/tsconfig.json`, `packages/payments/vitest.config.ts`, `packages/payments/src/index.ts`, `packages/payments/test/manual.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChargeRequest`, `ChargeResult`, `WebhookVerdict`, `PaymentProvider`, `manualProvider`, `providerFor(key)`, `PROVIDER_KEYS`.

- [ ] **Step 1: Scaffold the package**

`packages/payments/package.json`:

```json
{
  "name": "@xperiment/payments",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:cov": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@vitest/coverage-v8": "^2.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`packages/payments/tsconfig.json` and `packages/payments/vitest.config.ts` — copy
`packages/plans/tsconfig.json` and `packages/plans/vitest.config.ts` verbatim.

Run `pnpm install` from the repo root so the workspace link exists.

- [ ] **Step 2: Write the failing tests**

Create `packages/payments/test/manual.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { manualProvider, providerFor, PROVIDER_KEYS } from '../src/index.js';

const req = {
  invoiceId: '11111111-1111-1111-1111-111111111111',
  workspaceId: '22222222-2222-2222-2222-222222222222',
  totalMinor: 165_390,
  currency: 'IDR',
};

describe('providerFor', () => {
  test('resolves every advertised key', () => {
    for (const key of PROVIDER_KEYS) expect(providerFor(key)?.key).toBe(key);
  });

  test('returns null for an unknown key rather than throwing', () => {
    expect(providerFor('midtrans')).toBeNull();
    expect(providerFor('')).toBeNull();
    expect(providerFor('__proto__')).toBeNull();
  });
});

describe('manualProvider', () => {
  test('produces a deterministic reference for an invoice', async () => {
    const a = await manualProvider.createCharge(req);
    const b = await manualProvider.createCharge(req);
    expect(a.reference).toBe(b.reference);
    expect(a.reference).toMatch(/^XPERIMENT-/);
  });

  test('a different invoice gets a different reference', async () => {
    const other = await manualProvider.createCharge({ ...req, invoiceId: '33333333-3333-3333-3333-333333333333' });
    expect(other.reference).not.toBe((await manualProvider.createCharge(req)).reference);
  });

  test('the instructions name the amount and the reference', async () => {
    const charge = await manualProvider.createCharge(req);
    expect(charge.instructions).toContain(charge.reference);
    expect(charge.instructions).toContain('165390');
  });

  test('never verifies a webhook — a manual transfer has no callback', () => {
    expect(manualProvider.verifyWebhook('{}', {}, 'secret')).toBeNull();
    expect(manualProvider.verifyWebhook('', {}, '')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/payments test`
Expected: FAIL — `Failed to resolve import "../src/index.js"`.

- [ ] **Step 4: Implement the package**

Create `packages/payments/src/index.ts`:

```ts
import { createHash } from 'node:crypto';

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
  /**
   * The verdict, or `null` for anything that cannot be positively verified — a bad
   * signature, a malformed body, an event we do not model. Returning null rather than
   * throwing keeps the caller's failure path total: unverified means mutate nothing.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): WebhookVerdict | null;
}

/**
 * Bank transfer settled by an admin. It is a real provider, not a stub: it issues a
 * stable reference a customer can quote on a transfer, and settlement happens through
 * the mark-paid route rather than a callback.
 */
export const manualProvider: PaymentProvider = {
  key: 'manual',
  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    // Deterministic so re-requesting payment for one invoice never mints a second
    // reference the customer might quote on a duplicate transfer.
    const digest = createHash('sha256').update(req.invoiceId).digest('hex').slice(0, 12).toUpperCase();
    const reference = `XPERIMENT-${digest}`;
    return {
      reference,
      instructions: `Transfer ${req.totalMinor} ${req.currency} and quote reference ${reference}. An administrator marks the invoice paid once the transfer clears.`,
    };
  },
  verifyWebhook(): WebhookVerdict | null {
    return null;
  },
};

const PROVIDERS: Record<string, PaymentProvider> = { manual: manualProvider };

export const PROVIDER_KEYS: readonly string[] = Object.keys(PROVIDERS);

/** Null for an unknown key. Uses a prototype-free lookup so `__proto__` cannot resolve. */
export function providerFor(key: string): PaymentProvider | null {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? (PROVIDERS[key] ?? null) : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/payments test:cov && pnpm --filter @xperiment/payments typecheck`
Expected: PASS, 6 tests, coverage 100%, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/payments pnpm-lock.yaml
git commit -m "feat: add the payment provider contract and the manual provider"
```

---

### Task O-3: Migration 0011 and the invoices repo

**Files:**
- Create: `packages/db/src/migrations/0011_invoices.sql`, `packages/db/src/repos/invoices.ts`, `packages/db/test/invoices.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `InvoiceDraft`, `PlanCode`, `CURRENCY` from `@xperiment/plans` (O-1); `withTx` from `packages/db/src/tx.ts`.
- Produces: `InvoiceRow`, `InvoiceLineRow`, `InvoiceStatus`, `issueInvoice`, `listInvoices`, `getInvoice`, `markInvoicePaid`, `setInvoiceProvider`, `workspacesNeedingInvoice`.

- [ ] **Step 1: Write the migration**

Create `packages/db/src/migrations/0011_invoices.sql`:

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

- [ ] **Step 2: Write the failing tests**

Create `packages/db/test/invoices.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { buildInvoice, DEFAULT_TAX_RATE_BPS, previousPeriod, resolveLimits } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createPool,
  createUser,
  createWorkspaceWithOwner,
  getInvoice,
  issueInvoice,
  listInvoices,
  markInvoicePaid,
  runMigrations,
  setInvoiceProvider,
  workspacesNeedingInvoice,
} from '../src/index.js';

let pool: Pool;
const period = previousPeriod(new Date());

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newWorkspace(): Promise<string> {
  const user = await createUser(pool, { email: `inv-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Inv', userId: user!.id });
  return ws.id;
}

const draftFor = (planCode: 'free' | 'builder', executions = 0) =>
  buildInvoice({
    planCode,
    limits: resolveLimits(planCode, {}),
    usage: { executionsPerMonth: executions, aiTokensPerMonth: 0, activeWorkflows: 0, members: 0 },
    taxRateBps: DEFAULT_TAX_RATE_BPS,
  });

const issue = (workspaceId: string, planCode: 'free' | 'builder' = 'builder', executions = 0) =>
  issueInvoice(pool, {
    workspaceId,
    periodStart: period.start,
    periodEnd: period.end,
    planCode,
    draft: draftFor(planCode, executions),
  });

describe('issueInvoice', () => {
  test('writes the invoice and its lines atomically', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws);
    expect(inv).not.toBeNull();
    const full = await getInvoice(pool, inv!.id, ws);
    expect(full!.invoice.status).toBe('issued');
    expect(full!.invoice.totalMinor).toBe(draftFor('builder').totalMinor);
    expect(full!.lines).toHaveLength(1);
    expect(full!.lines[0]!.kind).toBe('subscription');
  });

  test('every persisted amount is an integer', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws, 'builder', 999_999);
    const full = await getInvoice(pool, inv!.id, ws);
    for (const v of [full!.invoice.subtotalMinor, full!.invoice.taxMinor, full!.invoice.totalMinor]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    for (const l of full!.lines) expect(Number.isInteger(l.amountMinor)).toBe(true);
  });

  test('a second issue for the same period returns null rather than throwing', async () => {
    const ws = await newWorkspace();
    expect(await issue(ws)).not.toBeNull();
    expect(await issue(ws)).toBeNull();
  });

  // The M and N lesson, twice proven: a sequential version of this passes against a
  // broken guard. Only a parallel one exercises the constraint.
  test('concurrent issues for one period produce exactly one invoice', async () => {
    const ws = await newWorkspace();
    await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')));
    const results = await Promise.all(Array.from({ length: 5 }, () => issue(ws)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await pool.query(`SELECT count(*)::int AS c FROM invoices WHERE workspace_id = $1`, [ws]);
    expect((rows.rows[0] as { c: number }).c).toBe(1);
  }, 30000);
});

describe('reads are tenant-scoped', () => {
  test('getInvoice refuses another workspace', async () => {
    const [a, b] = [await newWorkspace(), await newWorkspace()];
    const inv = await issue(a);
    expect(await getInvoice(pool, inv!.id, b)).toBeNull();
  });

  test('listInvoices returns only this workspace, newest first', async () => {
    const ws = await newWorkspace();
    await issue(ws);
    const items = await listInvoices(pool, ws, 10);
    expect(items).toHaveLength(1);
    expect(items[0]!.workspaceId).toBe(ws);
  });
});

describe('markInvoicePaid', () => {
  test('settles an issued invoice once and refuses the replay', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws);
    expect(await markInvoicePaid(pool, { id: inv!.id, workspaceId: ws, provider: 'manual', providerRef: 'XPERIMENT-1' })).toBe(true);
    expect(await markInvoicePaid(pool, { id: inv!.id, workspaceId: ws, provider: 'manual', providerRef: 'XPERIMENT-1' })).toBe(false);
    const full = await getInvoice(pool, inv!.id, ws);
    expect(full!.invoice.status).toBe('paid');
    expect(full!.invoice.paidAt).not.toBeNull();
  });

  test('refuses to settle another workspace’s invoice', async () => {
    const [a, b] = [await newWorkspace(), await newWorkspace()];
    const inv = await issue(a);
    expect(await markInvoicePaid(pool, { id: inv!.id, workspaceId: b, provider: 'manual', providerRef: 'X' })).toBe(false);
  });

  test('setInvoiceProvider records the charge reference without settling', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws);
    expect(await setInvoiceProvider(pool, { id: inv!.id, workspaceId: ws, provider: 'manual', providerRef: 'XPERIMENT-9' })).toBe(true);
    const full = await getInvoice(pool, inv!.id, ws);
    expect(full!.invoice.providerRef).toBe('XPERIMENT-9');
    expect(full!.invoice.status).toBe('issued');
  });
});

describe('workspacesNeedingInvoice', () => {
  test('lists a workspace with no invoice for the period', async () => {
    const ws = await newWorkspace();
    const ids = (await workspacesNeedingInvoice(pool, period)).map((w) => w.workspaceId);
    expect(ids).toContain(ws);
  });

  test('omits a workspace already invoiced', async () => {
    const ws = await newWorkspace();
    await issue(ws);
    const ids = (await workspacesNeedingInvoice(pool, period)).map((w) => w.workspaceId);
    expect(ids).not.toContain(ws);
  });

  test('omits a workspace created after the period ended', async () => {
    const ws = await newWorkspace(); // created now, i.e. after any past period
    const ancient = { start: new Date(Date.UTC(2020, 0, 1)), end: new Date(Date.UTC(2020, 1, 1)) };
    const ids = (await workspacesNeedingInvoice(pool, ancient)).map((w) => w.workspaceId);
    expect(ids).not.toContain(ws);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker start postgres redis && pnpm --filter @xperiment/db test -- invoices.test.ts`
Expected: FAIL — `issueInvoice is not exported`.

- [ ] **Step 4: Implement the repo**

Create `packages/db/src/repos/invoices.ts`:

```ts
import { CURRENCY, type InvoiceDraft, type InvoiceLineKind, type PlanCode } from '@xperiment/plans';
import type pg from 'pg';
import { type Db } from '../pool.js';
import { withTx } from '../tx.js';

export type InvoiceStatus = 'issued' | 'paid' | 'void';

export interface InvoiceRow {
  id: string;
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  planCode: string;
  currency: string;
  subtotalMinor: number;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  status: InvoiceStatus;
  provider: string | null;
  providerRef: string | null;
  issuedAt: string;
  paidAt: string | null;
}

export interface InvoiceLineRow {
  id: string;
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
}

const ts = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

function mapInvoice(r: Record<string, unknown>): InvoiceRow {
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    periodStart: day(r['period_start']),
    periodEnd: day(r['period_end']),
    planCode: r['plan_code'] as string,
    currency: r['currency'] as string,
    subtotalMinor: Number(r['subtotal_minor']),
    taxRateBps: Number(r['tax_rate_bps']),
    taxMinor: Number(r['tax_minor']),
    totalMinor: Number(r['total_minor']),
    status: r['status'] as InvoiceStatus,
    provider: (r['provider'] as string | null) ?? null,
    providerRef: (r['provider_ref'] as string | null) ?? null,
    issuedAt: ts(r['issued_at'])!,
    paidAt: ts(r['paid_at']),
  };
}

function mapLine(r: Record<string, unknown>): InvoiceLineRow {
  return {
    id: r['id'] as string,
    kind: r['kind'] as InvoiceLineKind,
    description: r['description'] as string,
    quantity: Number(r['quantity']),
    unitPriceMinor: Number(r['unit_price_minor']),
    amountMinor: Number(r['amount_minor']),
  };
}

/**
 * Issue an invoice with its lines, atomically. Returns `null` when the period is already
 * invoiced: `UNIQUE (workspace_id, period_start)` makes the close sweep idempotent by
 * construction, so a duplicate is an ordinary outcome rather than an error.
 */
export async function issueInvoice(
  pool: pg.Pool,
  args: { workspaceId: string; periodStart: Date; periodEnd: Date; planCode: PlanCode; draft: InvoiceDraft },
): Promise<InvoiceRow | null> {
  try {
    return await withTx(pool, async (client) => {
      const r = await client.query(
        `INSERT INTO invoices
           (workspace_id, period_start, period_end, plan_code, currency,
            subtotal_minor, tax_rate_bps, tax_minor, total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          args.workspaceId,
          args.periodStart,
          args.periodEnd,
          args.planCode,
          CURRENCY,
          args.draft.subtotalMinor,
          args.draft.taxRateBps,
          args.draft.taxMinor,
          args.draft.totalMinor,
        ],
      );
      const invoice = mapInvoice(r.rows[0] as Record<string, unknown>);
      for (const l of args.draft.lines) {
        await client.query(
          `INSERT INTO invoice_lines (invoice_id, kind, description, quantity, unit_price_minor, amount_minor)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [invoice.id, l.kind, l.description, l.quantity, l.unitPriceMinor, l.amountMinor],
        );
      }
      return invoice;
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return null; // already invoiced
    throw e;
  }
}

export async function listInvoices(db: Db, workspaceId: string, limit: number): Promise<InvoiceRow[]> {
  const r = await db.query(
    `SELECT * FROM invoices WHERE workspace_id = $1 ORDER BY period_start DESC LIMIT $2`,
    [workspaceId, Math.min(Math.max(limit, 1), 100)],
  );
  return (r.rows as Record<string, unknown>[]).map(mapInvoice);
}

export async function getInvoice(
  db: Db,
  id: string,
  workspaceId: string,
): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null> {
  const r = await db.query(`SELECT * FROM invoices WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!r.rowCount) return null;
  const invoice = mapInvoice(r.rows[0] as Record<string, unknown>);
  const lines = await db.query(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id`, [id]);
  return { invoice, lines: (lines.rows as Record<string, unknown>[]).map(mapLine) };
}

/** Record which provider is collecting, without settling. */
export async function setInvoiceProvider(
  db: Db,
  args: { id: string; workspaceId: string; provider: string; providerRef: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE invoices SET provider = $3, provider_ref = $4
     WHERE id = $1 AND workspace_id = $2 AND status = 'issued'`,
    [args.id, args.workspaceId, args.provider, args.providerRef],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Compare-and-set from `issued` to `paid`. A replayed webhook or a double-clicked
 * button returns false and settles nothing — the same discipline the execution state
 * machine uses. There is deliberately no generic invoice update: status is the only
 * mutation this repo exposes, which is what keeps an issued invoice immutable.
 */
export async function markInvoicePaid(
  db: Db,
  args: { id: string; workspaceId: string; provider: string; providerRef: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE invoices SET status = 'paid', paid_at = now(), provider = $3, provider_ref = $4
     WHERE id = $1 AND workspace_id = $2 AND status = 'issued'`,
    [args.id, args.workspaceId, args.provider, args.providerRef],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Workspaces whose closed period has no invoice yet.
 *
 * A workspace created at or after `periodEnd` did not exist during the period and must
 * not be billed for it — without that filter every new signup would receive a spurious
 * subscription charge for a month it was never a customer.
 */
export async function workspacesNeedingInvoice(
  db: Db,
  period: { start: Date; end: Date },
): Promise<{ workspaceId: string }[]> {
  const r = await db.query(
    `SELECT w.id FROM workspaces w
     WHERE w.created_at < $2
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.workspace_id = w.id AND i.period_start = $1)
     ORDER BY w.created_at`,
    [period.start, period.end],
  );
  return (r.rows as { id: string }[]).map((row) => ({ workspaceId: row.id }));
}
```

Add `"@xperiment/payments": "workspace:*"` is **not** needed here — the db package needs only
`@xperiment/plans`, which it already depends on from N.

Add to `packages/db/src/index.ts`:

```ts
export * from './repos/invoices.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/db test -- invoices.test.ts`
Expected: PASS, 11 tests including the parallel one.

Then prove the parallel test earns its place: temporarily drop the unique constraint with
`docker exec postgres psql -U postgres -d xperiment -c "ALTER TABLE invoices DROP CONSTRAINT invoices_period_unique;"`,
re-run, and confirm the concurrent test FAILS while the sequential duplicate test still
passes. Restore with
`docker exec postgres psql -U postgres -d xperiment -c "ALTER TABLE invoices ADD CONSTRAINT invoices_period_unique UNIQUE (workspace_id, period_start);"`
and confirm green again.

- [ ] **Step 6: Run the whole db suite and commit**

Run: `pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck`
Expected: all green.

```bash
git add packages/db
git commit -m "feat: add the invoices schema and repository"
```

---

### Task O-4: The monthly close sweep

**Files:**
- Create: `apps/scheduler/src/invoiceSweep.ts`, `apps/scheduler/test/invoiceSweep.test.ts`
- Modify: `apps/scheduler/src/main.ts:23`, `apps/scheduler/package.json`

**Interfaces:**
- Consumes: `workspacesNeedingInvoice`, `issueInvoice`, `getWorkspacePlan`, `getQuotaUsage` from `@xperiment/db`; `buildInvoice`, `previousPeriod`, `resolveLimits`, `DEFAULT_TAX_RATE_BPS` from `@xperiment/plans`.
- Produces: `runInvoiceSweep(deps): Promise<{ issued: number }>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/scheduler/test/invoiceSweep.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createPool, createUser, createWorkspaceWithOwner, listInvoices, runMigrations } from '@xperiment/db';
import { previousPeriod } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runInvoiceSweep } from '../src/invoiceSweep.js';

let pool: Pool;
const period = previousPeriod(new Date());
const deps = () => ({ pool, log: () => {} });

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

/** A workspace back-dated into the closed period, on `planCode`, with `executions` used. */
async function seed(planCode: string, executions: number): Promise<string> {
  const user = await createUser(pool, { email: `sw-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Sweep', userId: user!.id });
  await pool.query(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [ws.id, period.start]);
  await pool.query(`UPDATE workspace_plans SET plan_code = $2 WHERE workspace_id = $1`, [ws.id, planCode]);
  await pool.query(
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     VALUES ($1,$2,'execution',$3)
     ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = $3`,
    [ws.id, period.start, executions],
  );
  return ws.id;
}

describe('runInvoiceSweep', () => {
  test('issues one invoice for the closed period', async () => {
    const ws = await seed('builder', 10);
    await runInvoiceSweep(deps());
    const invoices = await listInvoices(pool, ws, 10);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.planCode).toBe('builder');
    expect(invoices[0]!.periodStart).toBe(period.start.toISOString().slice(0, 10));
  });

  test('is idempotent — a second sweep issues nothing more', async () => {
    const ws = await seed('builder', 5);
    await runInvoiceSweep(deps());
    await runInvoiceSweep(deps());
    expect(await listInvoices(pool, ws, 10)).toHaveLength(1);
  });

  test('bills overage from the closed period’s counters', async () => {
    const ws = await seed('builder', 10_050); // builder allows 10_000
    await runInvoiceSweep(deps());
    const full = (await listInvoices(pool, ws, 1))[0]!;
    // 149_000 subscription + 50 executions * 25 = 150_250 subtotal
    expect(full.subtotalMinor).toBe(149_000 + 50 * 25);
  });

  test('never invoices the current period', async () => {
    const ws = await seed('builder', 3);
    await runInvoiceSweep(deps());
    const invoices = await listInvoices(pool, ws, 10);
    const current = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    expect(invoices.map((i) => i.periodStart)).not.toContain(current);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/scheduler test -- invoiceSweep.test.ts`
Expected: FAIL — cannot resolve `../src/invoiceSweep.js`.

- [ ] **Step 3: Implement the sweep**

Add `"@xperiment/plans": "workspace:*"` to `apps/scheduler/package.json` dependencies if it is
not already there from N (it is — N added it), then create
`apps/scheduler/src/invoiceSweep.ts`:

```ts
import { getQuotaUsage, getWorkspacePlan, issueInvoice, withTx, workspacesNeedingInvoice } from '@xperiment/db';
import { buildInvoice, DEFAULT_TAX_RATE_BPS, previousPeriod, resolveLimits } from '@xperiment/plans';
import type pg from 'pg';

export interface InvoiceSweepDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

function taxRateBps(): number {
  const raw = Number(process.env['INVOICE_TAX_RATE_BPS']);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_TAX_RATE_BPS;
}

/**
 * Close the previous calendar month into one invoice per workspace.
 *
 * Only ever the previous period: a period is billable once nothing can still write to
 * it, and the counter rows for a closed month are inert by then. Issuing is idempotent
 * through `UNIQUE (workspace_id, period_start)`, so two scheduler instances racing
 * produce one invoice and one skipped duplicate.
 */
export async function runInvoiceSweep(deps: InvoiceSweepDeps): Promise<{ issued: number }> {
  const period = previousPeriod(new Date());
  const due = await workspacesNeedingInvoice(deps.pool, period);
  let issued = 0;

  for (const { workspaceId } of due) {
    try {
      const plan = await getWorkspacePlan(deps.pool, workspaceId);
      const limits = resolveLimits(plan.planCode, plan.limitOverrides);
      const usage = await getQuotaUsage(deps.pool, workspaceId, period.start);
      const draft = buildInvoice({ planCode: plan.planCode, limits, usage, taxRateBps: taxRateBps() });
      const invoice = await issueInvoice(deps.pool, {
        workspaceId,
        periodStart: period.start,
        periodEnd: period.end,
        planCode: plan.planCode,
        draft,
      });
      if (invoice) issued += 1;
    } catch (e) {
      // One workspace must never stall the batch for every other one.
      deps.log('invoice_sweep.workspace_failed', { workspaceId, err: (e as Error).message });
    }
  }

  if (issued) deps.log('invoice_sweep.done', { issued, periodStart: period.start.toISOString() });
  return { issued };
}
```

Note this sweep does not need `withTx` at the batch level: `issueInvoice` owns its own
transaction, and per-workspace isolation comes from the try/catch rather than a savepoint,
because there is no enclosing transaction to protect. Remove the unused `withTx` import.

- [ ] **Step 4: Wire it into the loop**

In `apps/scheduler/src/main.ts`, add the import and extend the `Promise.all`:

```ts
import { runInvoiceSweep } from './invoiceSweep.js';
```

```ts
  void Promise.all([
    runSchedulerTick({ pool, log }),
    runWaitSweep({ pool, log }),
    runAlertSweep({ pool, log }),
    runInvoiceSweep({ pool, log }),
  ])
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/scheduler test && pnpm --filter @xperiment/scheduler typecheck`
Expected: PASS, whole scheduler suite green, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/scheduler
git commit -m "feat: close each billing period into an invoice"
```

---

### Task O-5: Invoice routes, payment, and the webhook intake

**Files:**
- Create: `apps/api/src/routes/invoices.ts`, `apps/api/test/invoices.test.ts`
- Modify: `apps/api/package.json`, `apps/api/src/routes/deps.ts`, `apps/api/src/server.ts`, `apps/api/src/openapi.ts`, `apps/api/test/rbac.test.ts`, `.env.example`

**Interfaces:**
- Consumes: `listInvoices`, `getInvoice`, `markInvoicePaid`, `setInvoiceProvider` from `@xperiment/db` (O-3); `providerFor`, `manualProvider` from `@xperiment/payments` (O-2); `requirePermission`, `authOf` from the auth plugin.
- Produces: `registerInvoiceRoutes(app, deps)`; `ResolvedServerDeps` gains `paymentProvider: PaymentProvider` and `paymentWebhookSecret: string | null`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/invoices.test.ts`:

```ts
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, issueInvoice, runMigrations } from '@xperiment/db';
import { buildInvoice, DEFAULT_TAX_RATE_BPS, previousPeriod, resolveLimits } from '@xperiment/plans';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
const period = previousPeriod(new Date());

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function seedInvoice(user: AuthedUser): Promise<string> {
  const draft = buildInvoice({
    planCode: 'builder',
    limits: resolveLimits('builder', {}),
    usage: { executionsPerMonth: 0, aiTokensPerMonth: 0, activeWorkflows: 0, members: 0 },
    taxRateBps: DEFAULT_TAX_RATE_BPS,
  });
  const inv = await issueInvoice(pool, {
    workspaceId: user.workspaceId,
    periodStart: period.start,
    periodEnd: period.end,
    planCode: 'builder',
    draft,
  });
  return inv!.id;
}

describe('GET /v1/invoices', () => {
  test('lists the workspace invoices for a billing reader', async () => {
    const user = await createAuthedUser(app);
    await seedInvoice(user);
    const billing = await addMemberWithRole(app, pool, user.workspaceId, 'billing');
    const r = await billing.inject({ method: 'GET', url: '/v1/invoices' });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  test('a viewer cannot read invoices', async () => {
    const user = await createAuthedUser(app);
    const viewer = await addMemberWithRole(app, pool, user.workspaceId, 'viewer');
    expect((await viewer.inject({ method: 'GET', url: '/v1/invoices' })).statusCode).toBe(403);
  });
});

describe('GET /v1/invoices/:id', () => {
  test('returns the invoice with its lines', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    const r = await user.inject({ method: 'GET', url: `/v1/invoices/${id}` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ invoice: { status: string }; lines: { kind: string }[] }>();
    expect(body.invoice.status).toBe('issued');
    expect(body.lines[0]!.kind).toBe('subscription');
  });

  test('404s another workspace’s invoice', async () => {
    const owner = await createAuthedUser(app);
    const id = await seedInvoice(owner);
    const other = await createAuthedUser(app);
    expect((await other.inject({ method: 'GET', url: `/v1/invoices/${id}` })).statusCode).toBe(404);
  });

  test('404s a malformed id rather than raising a pg error', async () => {
    const user = await createAuthedUser(app);
    expect((await user.inject({ method: 'GET', url: '/v1/invoices/not-a-uuid' })).statusCode).toBe(404);
  });
});

describe('payment', () => {
  test('pay returns a reference and records the provider without settling', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    const r = await user.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ reference: string; instructions: string }>();
    expect(body.reference).toMatch(/^XPERIMENT-/);
    const after = await user.inject({ method: 'GET', url: `/v1/invoices/${id}` });
    expect(after.json<{ invoice: { status: string; providerRef: string } }>().invoice.status).toBe('issued');
    expect(after.json<{ invoice: { providerRef: string } }>().invoice.providerRef).toBe(body.reference);
  });

  test('mark-paid settles once and 409s the replay', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    expect((await user.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(200);
    expect((await user.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(409);
    const after = await user.inject({ method: 'GET', url: `/v1/invoices/${id}` });
    expect(after.json<{ invoice: { status: string } }>().invoice.status).toBe('paid');
  });

  test('an operator cannot settle an invoice', async () => {
    const owner = await createAuthedUser(app);
    const id = await seedInvoice(owner);
    const operator = await addMemberWithRole(app, pool, owner.workspaceId, 'operator');
    expect((await operator.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(403);
  });
});

describe('POST /v1/payments/:provider/webhook', () => {
  test('401s an unknown provider', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/payments/midtrans/webhook', payload: {} });
    expect(r.statusCode).toBe(401);
  });

  test('401s the manual provider, which has no callback', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/payments/manual/webhook', payload: { any: 'thing' } });
    expect(r.statusCode).toBe(401);
  });

  test('needs no authentication to be refused', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/payments/manual/webhook', payload: {} });
    expect(r.statusCode).not.toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @xperiment/api test -- invoices.test.ts`
Expected: FAIL — `GET /v1/invoices` returns 404.

- [ ] **Step 3: Add the dependency and the config**

Add `"@xperiment/payments": "workspace:*"` to `apps/api/package.json` dependencies and run
`pnpm install` from the repo root.

In `apps/api/src/routes/deps.ts`, add to `ResolvedServerDeps`:

```ts
  paymentProvider: import('@xperiment/payments').PaymentProvider;
  paymentWebhookSecret: string | null;
```

In `apps/api/src/server.ts`, import and resolve them beside the other deps:

```ts
import { manualProvider, providerFor } from '@xperiment/payments';
```

```ts
    paymentProvider:
      deps.paymentProvider ??
      // A typo must fail at startup, not silently disable payment on every request.
      (() => {
        const key = process.env['PAYMENT_PROVIDER'] ?? 'manual';
        const provider = providerFor(key);
        if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER: ${key}`);
        return provider;
      })(),
    paymentWebhookSecret: deps.paymentWebhookSecret ?? process.env['PAYMENT_WEBHOOK_SECRET'] ?? null,
```

and add the two optional fields to the `ServerDeps` interface beside `gatewayUrl`:

```ts
  paymentProvider?: import('@xperiment/payments').PaymentProvider;
  paymentWebhookSecret?: string | null;
```

Append to `.env.example`:

```
# Billing (Phase 3O)
INVOICE_TAX_RATE_BPS=1100
PAYMENT_PROVIDER=manual
PAYMENT_WEBHOOK_SECRET=
```

- [ ] **Step 4: Implement the routes**

Create `apps/api/src/routes/invoices.ts`:

```ts
import { getInvoice, listInvoices, markInvoicePaid, setInvoiceProvider } from '@xperiment/db';
import { providerFor } from '@xperiment/payments';
import type { FastifyInstance } from 'fastify';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerInvoiceRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/invoices', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:read')) return;
    const raw = Number((req.query as { limit?: string }).limit ?? 24);
    return { items: await listInvoices(deps.pool, ctx.workspaceId, Number.isFinite(raw) ? raw : 24) };
  });

  app.get('/v1/invoices/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:read')) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return sendProblem(reply, 404, 'Invoice not found'); // avoid a pg 22P02 500
    const found = await getInvoice(deps.pool, id, ctx.workspaceId);
    if (!found) return sendProblem(reply, 404, 'Invoice not found');
    return found;
  });

  app.post('/v1/invoices/:id/pay', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:manage')) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return sendProblem(reply, 404, 'Invoice not found');
    const found = await getInvoice(deps.pool, id, ctx.workspaceId);
    if (!found) return sendProblem(reply, 404, 'Invoice not found');
    if (found.invoice.status !== 'issued') {
      return sendProblem(reply, 409, 'Invoice not payable', `Status is ${found.invoice.status}`);
    }
    const charge = await deps.paymentProvider.createCharge({
      invoiceId: found.invoice.id,
      workspaceId: ctx.workspaceId,
      totalMinor: found.invoice.totalMinor,
      currency: found.invoice.currency,
    });
    await setInvoiceProvider(deps.pool, {
      id,
      workspaceId: ctx.workspaceId,
      provider: deps.paymentProvider.key,
      providerRef: charge.reference,
    });
    return { provider: deps.paymentProvider.key, ...charge };
  });

  app.post('/v1/invoices/:id/mark-paid', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:manage')) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return sendProblem(reply, 404, 'Invoice not found');
    const found = await getInvoice(deps.pool, id, ctx.workspaceId);
    if (!found) return sendProblem(reply, 404, 'Invoice not found');
    const settled = await markInvoicePaid(deps.pool, {
      id,
      workspaceId: ctx.workspaceId,
      provider: found.invoice.provider ?? deps.paymentProvider.key,
      providerRef: found.invoice.providerRef ?? 'manual-settlement',
    });
    // CAS: a replay settles nothing rather than paying twice.
    if (!settled) return sendProblem(reply, 409, 'Invoice already settled', `Status is ${found.invoice.status}`);
    return { status: 'paid' };
  });

  // Unauthenticated by design — the signature is the credential. Anything that cannot
  // be positively verified is a 401 that mutates nothing.
  app.post('/v1/payments/:provider/webhook', async (req, reply) => {
    const { provider: key } = req.params as { provider: string };
    const provider = providerFor(key);
    if (!provider || !deps.paymentWebhookSecret) return sendProblem(reply, 401, 'Unverified webhook');
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const verdict = provider.verifyWebhook(raw, req.headers as Record<string, string | undefined>, deps.paymentWebhookSecret);
    // Never log `raw` — a provider body can carry secrets.
    if (!verdict) return sendProblem(reply, 401, 'Unverified webhook');

    const found = await deps.pool.query(`SELECT id, workspace_id FROM invoices WHERE provider_ref = $1 AND provider = $2`, [
      verdict.invoiceRef,
      provider.key,
    ]);
    const row = found.rows[0] as { id: string; workspace_id: string } | undefined;
    if (!row) return sendProblem(reply, 404, 'Unknown invoice reference');
    if (verdict.status === 'paid') {
      await markInvoicePaid(deps.pool, {
        id: row.id,
        workspaceId: row.workspace_id,
        provider: provider.key,
        providerRef: verdict.invoiceRef,
      });
    }
    return { received: true };
  });
}
```

- [ ] **Step 5: Register the routes and document them**

In `apps/api/src/server.ts`, import `registerInvoiceRoutes` and call it beside
`registerPlanRoutes`.

In `apps/api/src/openapi.ts`, add to `paths`:

```ts
    '/v1/invoices': { get: { summary: 'List invoices', tags: ['billing'] } },
    '/v1/invoices/{id}': { get: { summary: 'Invoice with its line items', tags: ['billing'] } },
    '/v1/invoices/{id}/pay': { post: { summary: 'Create a charge with the configured provider', tags: ['billing'] } },
    '/v1/invoices/{id}/mark-paid': { post: { summary: 'Settle an invoice manually', tags: ['billing'] } },
    '/v1/payments/{provider}/webhook': { post: { summary: 'Signed provider callback', security: [], tags: ['billing'] } },
```

- [ ] **Step 6: Extend the RBAC matrix**

In `apps/api/test/rbac.test.ts`, add four rows to `MATRIX` after the existing billing rows:

```ts
  { permission: 'billing:read', method: 'GET', url: '/v1/invoices' },
  { permission: 'billing:read', method: 'GET', url: `/v1/invoices/${uuid}` },
  { permission: 'billing:manage', method: 'POST', url: `/v1/invoices/${uuid}/pay` },
  { permission: 'billing:manage', method: 'POST', url: `/v1/invoices/${uuid}/mark-paid` },
```

`UNROUTED` stays `[]`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck`
Expected: PASS — the whole API suite including the new file and the widened matrix.

- [ ] **Step 8: Commit**

```bash
git add apps/api .env.example pnpm-lock.yaml
git commit -m "feat: add the invoice and payment routes"
```

---

### Task O-6: Web invoices, e2e, docs, verification, review and merge

**Files:**
- Create: `apps/web/src/components/plan/InvoiceTable.tsx`
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/app/(app)/plan/page.tsx`, `apps/web/test/api.test.ts`, `e2e/test/acceptance.test.ts`, `README.md`

**Interfaces:**
- Consumes: `GET /v1/invoices`, `POST /v1/invoices/:id/mark-paid` (O-5); `forbiddenDetail`, `PermissionNotice` (M).
- Produces: `InvoiceSummary` type, `listInvoices()` / `markInvoicePaid()` client methods, `<InvoiceTable />`.

- [ ] **Step 1: Client methods, test first**

Add to the `apps/web/test/api.test.ts` matrix, after `updatePlan`:

```ts
    await client.listInvoices();
    await client.markInvoicePaid('i1');
```

and to the `seen` array:

```ts
      'GET /v1/invoices',
      'POST /v1/invoices/i1/mark-paid',
```

Run `pnpm --filter @xperiment/web test` → FAIL. Then add to `apps/web/src/lib/api.ts`:

```ts
export interface InvoiceSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  planCode: string;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  status: 'issued' | 'paid' | 'void';
}
```

and inside the `ApiClient` class:

```ts
  listInvoices(): Promise<{ items: InvoiceSummary[] }> {
    return this.request('GET', '/v1/invoices');
  }

  markInvoicePaid(id: string): Promise<{ status: string }> {
    return this.request('POST', `/v1/invoices/${id}/mark-paid`);
  }
```

Run again → PASS.

- [ ] **Step 2: Build the invoice table**

Create `apps/web/src/components/plan/InvoiceTable.tsx`:

```tsx
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionNotice } from '../ui/PermissionNotice';
import { getBrowserClient } from '../../lib/api';
import type { InvoiceSummary } from '../../lib/api';
import { forbiddenDetail } from '../../lib/permissions';

/** Whole rupiah, grouped — amounts are integers, so no decimal handling is needed. */
function money(minor: number, currency: string): string {
  return `${currency} ${minor.toLocaleString('id-ID')}`;
}

const STATUS_COLOR: Record<InvoiceSummary['status'], string> = {
  issued: 'var(--color-amber)',
  paid: 'var(--color-jade)',
  void: 'var(--text-muted)',
};

export function InvoiceTable() {
  const qc = useQueryClient();
  const invoicesQ = useQuery({
    queryKey: ['invoices'],
    queryFn: () => getBrowserClient().listInvoices(),
    retry: false,
  });
  const settle = useMutation({
    mutationFn: (id: string) => getBrowserClient().markInvoicePaid(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });

  const forbidden = forbiddenDetail(invoicesQ.error);
  if (forbidden) return <PermissionNotice detail={forbidden} />;

  const items = invoicesQ.data?.items ?? [];
  if (invoicesQ.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading invoices…</p>;
  if (items.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }} data-testid="invoices-empty">
        No invoices yet — the first one is issued when this billing period closes.
      </p>
    );
  }

  return (
    <table className="q-table" data-testid="invoice-table">
      <thead>
        <tr>
          <th>Period</th>
          <th>Plan</th>
          <th>Total</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((inv) => (
          <tr key={inv.id} data-testid={`invoice-${inv.id}`}>
            <td className="mono">{inv.periodStart}</td>
            <td>{inv.planCode}</td>
            <td className="mono">{money(inv.totalMinor, inv.currency)}</td>
            <td style={{ color: STATUS_COLOR[inv.status] }}>{inv.status}</td>
            <td>
              {inv.status === 'issued' ? (
                <button
                  className="q-btn q-btn--ghost q-btn--sm"
                  disabled={settle.isPending}
                  onClick={() => settle.mutate(inv.id)}
                  data-testid={`settle-${inv.id}`}
                >
                  Mark paid
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Mount it on the plan page**

In `apps/web/src/app/(app)/plan/page.tsx`, import `InvoiceTable` and render it below the
limits table, inside the `plan ? ... : null` block, after the period-note paragraph:

```tsx
              <h2 style={{ fontSize: 'var(--text-h2)', margin: 'var(--space-6) 0 var(--space-3)' }}>Invoices</h2>
              <InvoiceTable />
```

Run: `pnpm --filter @xperiment/web test && pnpm --filter @xperiment/web typecheck && pnpm --filter @xperiment/web build`
Expected: all pass, `/plan` still builds.

- [ ] **Step 4: E2E — close a period, check the total, settle it**

Append to `e2e/test/acceptance.test.ts`, inside the existing describe:

```ts
  test('a closed period becomes an invoice that can be settled', async () => {
    // Resolve the shared e2e workspace via a created workflow row.
    const probe = await api<{ id: string }>('POST', '/v1/workflows', { name: 'invoice-probe' });
    const wsRow = await pool.query(`SELECT workspace_id FROM workflows WHERE id=$1`, [probe.body.id]);
    const ws = (wsRow.rows[0] as { workspace_id: string }).workspace_id;

    // Back-date the workspace and seed last month's counters, then let the scheduler close it.
    const period = await pool.query(
      `SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '1 month')::date AS start`,
    );
    const start = (period.rows[0] as { start: Date }).start;
    await pool.query(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [ws, start]);
    await pool.query(`UPDATE workspace_plans SET plan_code = 'builder' WHERE workspace_id = $1`, [ws]);
    await pool.query(
      `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
       VALUES ($1,$2,'execution',10040)
       ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = 10040`,
      [ws, start],
    );
    await pool.query(`DELETE FROM invoices WHERE workspace_id = $1 AND period_start = $2`, [ws, start]);

    // The scheduler sweeps every 500ms in e2e; poll for the invoice.
    const deadline = Date.now() + 20000;
    let invoice: { id: string; totalMinor: number; status: string } | undefined;
    while (Date.now() < deadline) {
      const list = await api<{ items: { id: string; periodStart: string; totalMinor: number; status: string }[] }>(
        'GET',
        '/v1/invoices',
      );
      invoice = list.body.items.find((i) => i.periodStart === start.toISOString().slice(0, 10));
      if (invoice) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(invoice).toBeDefined();

    // builder: 149_000 subscription + 40 executions over 10_000 at 25 = 150_000 subtotal, +11% tax.
    const subtotal = 149_000 + 40 * 25;
    expect(invoice!.totalMinor).toBe(subtotal + Math.round((subtotal * 1100) / 10_000));

    const settled = await api<{ status: string }>('POST', `/v1/invoices/${invoice!.id}/mark-paid`);
    expect(settled.status).toBe(200);
    expect(settled.body.status).toBe('paid');
    expect((await api('POST', `/v1/invoices/${invoice!.id}/mark-paid`)).status).toBe(409);

    // Leave the shared workspace on its default plan for whatever runs next.
    await pool.query(`UPDATE workspace_plans SET plan_code = 'free' WHERE workspace_id = $1`, [ws]);
  }, 60000);
```

Run: `pnpm --filter @xperiment/e2e test` → all green.

- [ ] **Step 5: README**

Add a `## Invoices & payment (Phase 3O)` section after the plans section covering: the
price table and that the figures are placeholders; that all money is integer IDR and tax
is `round(subtotal × bps / 10000)` stamped once at issue; that the tax default of 11% is a
placeholder requiring real tax advice before a live deployment; the monthly close sweep
and that `UNIQUE (workspace_id, period_start)` is what makes it idempotent; that an
invoice is immutable except for its settlement status; the `manual` provider and how a
gateway adapter slots in behind `PaymentProvider`; the five routes and their permissions;
and the three environment variables with their defaults.

- [ ] **Step 6: Full verification**

```bash
docker start postgres redis
pnpm run test:cov      # every package ≥80% on all four metrics
pnpm typecheck
pnpm --filter @xperiment/e2e test
pnpm --filter @xperiment/web e2e
```

Add targeted tests if any package dips below 80% — do not lower a threshold.

- [ ] **Step 7: Commit**

```bash
git add apps/web e2e README.md
git commit -m "feat: add the web invoice table and the billing e2e"
```

- [ ] **Step 8: Adversarial review, then merge**

Run the multi-agent review over `master..HEAD` across four dimensions — **security** (can
a non-billing role read or settle an invoice; cross-tenant reads; does the webhook route
leak or mutate on an unverified request; is the raw body ever logged), **correctness**
(the close sweep under concurrency; month arithmetic at year boundaries; the
created-after-period filter; integer money throughout; CAS on settle), **typescript**
(`InvoiceStatus` and the web union agreeing; `providerFor` returning null; the
`@xperiment/plans` import cycle; `noUncheckedIndexedAccess` on `rows[0]`), and **test-gaps**
(routes without a matrix row; whether the parallel double-issue test actually fails
without the unique constraint; the void status having no path).

Refute each finding independently, fix everything confirmed, re-run the full verification
above, and then **re-review the fixes themselves** — both prior slices found a real defect
only on the second pass, one of them introduced by the first pass's fix. Then:

```bash
git checkout master && git merge --ff-only feature/phase3-invoices && git branch -d feature/phase3-invoices
```

---

## Self-Review

**Spec coverage.** Prices and `buildInvoice` → O-1. `PaymentProvider`, `manual`,
`providerFor` → O-2. Migration 0011, the repo, `issueInvoice` returning null on 23505,
the CAS settle, and the created-after-period filter → O-3. The close sweep, previous
period only, per-workspace isolation → O-4. The five routes, the three env vars, the RBAC
matrix rows → O-5. Web table, e2e, README, verification, review, merge → O-6. The spec's
tax caveat is carried into O-6 Step 5; the "no generic invoice update" rule is realised by
the repo in O-3 exposing only `setInvoiceProvider` and `markInvoicePaid`.

**Placeholder scan.** No TBD/TODO. Every code step carries real code; the two prose steps
(O-6 Step 5's README and O-6 Step 8's review) enumerate exactly what to write and what to
probe rather than saying "document it" or "review it".

**Type consistency.** `InvoiceDraft`, `InvoiceLine`, `InvoiceLineKind` are defined once in
O-1 and consumed by O-3's repo and O-4's sweep. `InvoiceRow.status` is `InvoiceStatus`
(`'issued' | 'paid' | 'void'`) in O-3 and the web `InvoiceSummary['status']` union in O-6
lists the same three. `previousPeriod` returns `{ start, end }` in O-1 and is destructured
that way in O-3's tests and O-4's sweep. `workspacesNeedingInvoice(db, period)` takes the
whole period object in both its definition (O-3) and its call site (O-4) — deliberately
not two positional dates, so the pair cannot be passed in the wrong order.
