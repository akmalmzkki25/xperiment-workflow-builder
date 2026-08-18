import { BILLING_TZ, LIMIT_KEYS, PLAN_CATALOG, type LimitKey, type PlanCode, type PlanLimits } from '@xperiment/plans';
import { type Db } from '../pool.js';

/** Only flows are counted; stocks are live count(*). */
export type CounterMetric = 'execution' | 'ai_tokens';

const COUNTER_TO_LIMIT: Record<CounterMetric, LimitKey> = {
  execution: 'executionsPerMonth',
  ai_tokens: 'aiTokensPerMonth',
};

export interface WorkspacePlanRow {
  workspaceId: string;
  planCode: PlanCode;
  limitOverrides: Partial<PlanLimits>;
  allowOverage: boolean;
}

const freeDefault = (workspaceId: string): WorkspacePlanRow => ({
  workspaceId,
  planCode: 'free',
  limitOverrides: {},
  allowOverage: false,
});

/**
 * A workspace with no row is on `free`, not unlimited — spend fails closed the same
 * way authorization does.
 */
export async function getWorkspacePlan(db: Db, workspaceId: string): Promise<WorkspacePlanRow> {
  const r = await db.query(
    `SELECT plan_code, limit_overrides, allow_overage FROM workspace_plans WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (!r.rowCount) return freeDefault(workspaceId);
  const row = r.rows[0] as Record<string, unknown>;
  const code = row['plan_code'] as string;
  return {
    workspaceId,
    planCode: (code in PLAN_CATALOG ? code : 'free') as PlanCode,
    limitOverrides: (row['limit_overrides'] ?? {}) as Partial<PlanLimits>,
    allowOverage: row['allow_overage'] === true,
  };
}

export async function setWorkspacePlan(
  db: Db,
  args: { workspaceId: string; planCode?: PlanCode; allowOverage?: boolean },
): Promise<WorkspacePlanRow> {
  await db.query(
    `INSERT INTO workspace_plans (workspace_id, plan_code, allow_overage)
     VALUES ($1, COALESCE($2,'free'), COALESCE($3,false))
     ON CONFLICT (workspace_id) DO UPDATE
       SET plan_code = COALESCE($2, workspace_plans.plan_code),
           allow_overage = COALESCE($3, workspace_plans.allow_overage),
           updated_at = now()`,
    [args.workspaceId, args.planCode ?? null, args.allowOverage ?? null],
  );
  return getWorkspacePlan(db, args.workspaceId);
}

export async function incrementUsageCounter(
  db: Db,
  args: { workspaceId: string; periodKey: string; metric: CounterMetric; quantity: number },
): Promise<void> {
  if (args.quantity <= 0) return;
  await db.query(
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     VALUES ($1,$2::date,$3,$4)
     ON CONFLICT (workspace_id, period_start, metric)
       DO UPDATE SET quantity = workspace_usage_counters.quantity + EXCLUDED.quantity`,
    [args.workspaceId, args.periodKey, args.metric, args.quantity],
  );
}

/** All four numbers: flows from counter rows, stocks from live count(*). */
export async function getQuotaUsage(
  db: Db,
  workspaceId: string,
  periodKey: string,
): Promise<Record<LimitKey, number>> {
  const counters = await db.query(
    `SELECT metric, quantity FROM workspace_usage_counters WHERE workspace_id = $1 AND period_start = $2::date`,
    [workspaceId, periodKey],
  );
  const gauges = await db.query(
    `SELECT
       (SELECT count(*) FROM workflows WHERE workspace_id = $1 AND active)::int AS active_workflows,
       (SELECT count(*) FROM workspace_members WHERE workspace_id = $1)::int AS members`,
    [workspaceId],
  );
  const used = Object.fromEntries(LIMIT_KEYS.map((k) => [k, 0])) as Record<LimitKey, number>;
  for (const row of counters.rows as { metric: CounterMetric; quantity: string }[]) {
    const key = COUNTER_TO_LIMIT[row.metric];
    if (key) used[key] = Number(row.quantity);
  }
  const g = gauges.rows[0] as { active_workflows: number; members: number };
  used.activeWorkflows = g.active_workflows;
  used.members = g.members;
  return used;
}

/**
 * Rebuild the flow counters from the ledger, which stays the billing source of truth.
 * Drift is therefore detectable and repairable rather than silent.
 */
export async function recomputeCounters(db: Db, workspaceId: string, periodKey: string): Promise<void> {
  await db.query(
    // The bounds are WIB midnights, not the bare date. `occurred_at >= $2::date` would
    // compare a timestamptz against a date cast with the SESSION TimeZone, which means
    // the boundary of a billing period would be a database setting rather than an
    // application decision — and on a UTC session it put 00:00-07:00 WIB on the 1st into
    // the previous month.
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     SELECT $1, $2::date, metric, COALESCE(SUM(quantity),0)
     FROM usage_events
     WHERE workspace_id = $1 AND metric IN ('execution','ai_tokens')
       AND occurred_at >= ($2::date::timestamp AT TIME ZONE $3)
       AND occurred_at < (($2::date + INTERVAL '1 month') AT TIME ZONE $3)
     GROUP BY metric
     ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [workspaceId, periodKey, BILLING_TZ],
  );
}
