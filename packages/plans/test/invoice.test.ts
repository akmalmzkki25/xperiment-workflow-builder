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
  type PlanCode,
} from '../src/index.js';

const usage = (over: Partial<Record<LimitKey, number>> = {}): Record<LimitKey, number> => ({
  executionsPerMonth: 0,
  aiTokensPerMonth: 0,
  activeWorkflows: 0,
  members: 0,
  ...over,
});

const invoice = (planCode: PlanCode, used: Partial<Record<LimitKey, number>> = {}) =>
  buildInvoice({
    planCode,
    limits: resolveLimits(planCode, {}),
    usage: usage(used),
    taxRateBps: DEFAULT_TAX_RATE_BPS,
  });

describe('PLAN_PRICING', () => {
  test('prices every plan in the catalog with whole rupiah', () => {
    for (const code of Object.keys(PLAN_CATALOG)) {
      const p = PLAN_PRICING[code as PlanCode];
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

  test('a half-unit of tax rounds up rather than truncating', () => {
    // builder's 149_000 at 5bps is exactly 74.5 — half-up gives 75, truncation would
    // give 74. Asserted against buildInvoice itself, not against Math.round on literals.
    const inv = buildInvoice({
      planCode: 'builder',
      limits: resolveLimits('builder', {}),
      usage: usage(),
      taxRateBps: 5,
    });
    expect(inv.subtotalMinor).toBe(149_000);
    expect(inv.taxMinor).toBe(75);
    expect(inv.totalMinor).toBe(149_075);
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

  test('an unknown plan code falls back to free pricing rather than crashing', () => {
    const inv = buildInvoice({
      planCode: 'gold' as PlanCode,
      limits: resolveLimits('free', {}),
      usage: usage(),
      taxRateBps: 1100,
    });
    expect(inv.subtotalMinor).toBe(0);
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
