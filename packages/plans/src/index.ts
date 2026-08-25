export type PlanCode = 'free' | 'builder' | 'team' | 'business';

export type LimitKey = 'executionsPerMonth' | 'aiTokensPerMonth' | 'activeWorkflows' | 'members';

export const LIMIT_KEYS: readonly LimitKey[] = [
  'executionsPerMonth',
  'aiTokensPerMonth',
  'activeWorkflows',
  'members',
];

/** `null` means unlimited — never 0, never Infinity. */
export type PlanLimits = Record<LimitKey, number | null>;

/**
 * The commercial ladder is a hypothesis (PRD §15: "Pricing final memerlukan customer
 * discovery"), so it lives here as one plain object a later slice can swap for rows
 * from a billing provider without touching a single enforcement site.
 */
export const PLAN_CATALOG: Record<PlanCode, PlanLimits> = {
  free: { executionsPerMonth: 500, aiTokensPerMonth: 50_000, activeWorkflows: 3, members: 2 },
  builder: { executionsPerMonth: 10_000, aiTokensPerMonth: 500_000, activeWorkflows: 20, members: 3 },
  team: { executionsPerMonth: 50_000, aiTokensPerMonth: 2_000_000, activeWorkflows: 100, members: 15 },
  business: { executionsPerMonth: null, aiTokensPerMonth: null, activeWorkflows: null, members: null },
};

export const PLAN_CODES = Object.keys(PLAN_CATALOG) as PlanCode[];

/**
 * How long a plan keeps run history, in days.
 *
 * A PARALLEL record rather than another key on PlanLimits, deliberately. Adding a key
 * to that type touches sixteen files across twenty sites, and the compiler forces only
 * one production file — LIMIT_KEYS is annotated `readonly LimitKey[]` rather than
 * exhaustiveness-checked, so a short array compiles and the new limit is then never
 * resolved, never evaluated and never returned, with no signal at all. Retention is
 * also a different KIND of number: a limit is a ceiling you enforce before acting,
 * this is an age after which you delete.
 */
export interface PlanRetention {
  /** Executions and everything that cascades from them. */
  executionDays: number;
  /** Recorded webhook bodies. Must be no shorter than executionDays. */
  triggerEventDays: number;
}

/**
 * NOT WIRED YET. `pruneExpired` takes its policy from the CLI, which defaults to 30 days
 * for every workspace — so a free plan currently keeps four weeks it is not entitled to
 * and a business plan loses eleven months it paid for. This is the intended schedule,
 * kept here rather than deleted so the gap stays visible.
 */
export const PLAN_RETENTION: Record<PlanCode, PlanRetention> = {
  free: { executionDays: 7, triggerEventDays: 7 },
  builder: { executionDays: 30, triggerEventDays: 30 },
  team: { executionDays: 90, triggerEventDays: 90 },
  business: { executionDays: 365, triggerEventDays: 365 },
};

/**
 * Floors enforced in code, not configuration.
 *
 * Audit and usage are NOT ordinary run history. Deleting usage early rewrites invoices
 * that were already sent; deleting audit early destroys the record of who did what,
 * which is the one thing an audit log exists for. These are the shortest either may
 * ever be, whatever a plan or an operator asks for.
 */
export const AUDIT_RETENTION_FLOOR_DAYS = 90;
export const USAGE_RETENTION_FLOOR_DAYS = 365;
/** Published outbox rows are bookkeeping; a week is generous for debugging a delivery. */
export const OUTBOX_RETENTION_DAYS = 7;

export const SOFT_LIMIT_RATIO = 0.8;

export type QuotaStatus = 'ok' | 'warn' | 'blocked';

export interface QuotaLine {
  metric: LimitKey;
  used: number;
  limit: number | null;
  status: QuotaStatus;
}

/** Catalog limits with per-workspace overrides applied. Unknown code → free (fail closed). */
export function resolveLimits(code: PlanCode, overrides: Partial<PlanLimits>): PlanLimits {
  const base = PLAN_CATALOG[code] ?? PLAN_CATALOG.free;
  const out = { ...base };
  for (const key of LIMIT_KEYS) {
    if (key in overrides) out[key] = overrides[key] ?? null;
  }
  return out;
}

export function evaluateQuota(
  limits: PlanLimits,
  used: Record<LimitKey, number>,
  allowOverage: boolean,
): QuotaLine[] {
  return LIMIT_KEYS.map((metric) => {
    const limit = limits[metric];
    const consumed = used[metric];
    let status: QuotaStatus = 'ok';
    if (limit !== null) {
      if (consumed >= limit) status = allowOverage ? 'warn' : 'blocked';
      else if (consumed >= limit * SOFT_LIMIT_RATIO) status = 'warn';
    }
    return { metric, used: consumed, limit, status };
  });
}

export function isBlocked(lines: readonly QuotaLine[], metric: LimitKey): boolean {
  return lines.some((l) => l.metric === metric && l.status === 'blocked');
}

// What a billing period is, in Asia/Jakarta rather than UTC. `periodStart`/`periodEnd`
// were removed rather than deprecated so tsc names every call site.
export * from './period.js';

// Pricing and invoice arithmetic. The cycle is type-only in the other direction —
// invoice.ts imports these types with `import type`, which TypeScript erases.
export * from './invoice.js';
