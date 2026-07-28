import type { LimitKey, PlanCode, PlanLimits } from './index.js';

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
