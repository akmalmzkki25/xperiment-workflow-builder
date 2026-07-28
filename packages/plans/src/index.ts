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

/** First instant of the UTC calendar month — the single definition of a billing period. */
export function periodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function periodEnd(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}
