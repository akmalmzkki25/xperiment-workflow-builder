import {
  dueAlertRules,
  evaluateFailureRate,
  evaluateUsageMetric,
  fireAlert,
  getQuotaUsage,
  getWorkspacePlan,
  withTx,
  type AlertRuleRow,
} from '@xperiment/db';
import { billingPeriod, evaluateQuota, resolveLimits } from '@xperiment/plans';
import type pg from 'pg';

export interface AlertSweepDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** Evaluate each due alert rule over usage_events; fire (once per cooldown) on breach. */
export async function runAlertSweep(deps: AlertSweepDeps): Promise<{ fired: number }> {
  let fired = 0;
  await withTx(deps.pool, async (client) => {
    const due = await dueAlertRules(client);
    // Savepoint per rule so one bad rule can't roll back the batch while still
    // holding the SKIP LOCKED locks.
    for (const rule of due) {
      await client.query('SAVEPOINT alert_item');
      try {
        const detail = await evaluate(client, rule);
        if (detail) {
          await fireAlert(client, { rule, detail, firedAt: new Date() });
          fired += 1;
        }
        await client.query('RELEASE SAVEPOINT alert_item');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT alert_item');
        deps.log('alert_sweep.rule_failed', { ruleId: rule.id, err: (e as Error).message });
      }
    }
  });
  if (fired) deps.log('alert_sweep.done', { fired });
  return { fired };
}

async function evaluate(client: pg.PoolClient, rule: AlertRuleRow): Promise<Record<string, unknown> | null> {
  if (rule.type === 'quota') {
    // Plan quota is a period-to-date state, not a rolling window, so it ignores
    // windowMinutes entirely and reads the same numbers the enforcement path does.
    const plan = await getWorkspacePlan(client, rule.workspaceId);
    const limits = resolveLimits(plan.planCode, plan.limitOverrides);
    const start = billingPeriod(new Date()).key;
    const usage = await getQuotaUsage(client, rule.workspaceId, start);
    const lines = evaluateQuota(limits, usage, plan.allowOverage);
    // Report the worst line: blocked outranks warn, and ok never fires.
    const worst = lines.find((l) => l.status === 'blocked') ?? lines.find((l) => l.status === 'warn');
    if (!worst) return null;
    return { metric: worst.metric, status: worst.status, used: worst.used, limit: worst.limit };
  }

  const windowMinutes = num(rule.params['windowMinutes'], 60);
  const windowStart = new Date(Date.now() - windowMinutes * 60_000);

  if (rule.type === 'failure_rate') {
    const threshold = num(rule.params['threshold'], 1);
    const minSample = num(rule.params['minSample'], 1);
    const { total, failed } = await evaluateFailureRate(client, { workspaceId: rule.workspaceId, windowStart });
    if (total < minSample) return null;
    const rate = failed / total;
    if (rate < threshold) return null;
    return { type: 'failure_rate', observed: rate, failed, total, threshold, windowMinutes };
  }

  // usage_threshold
  const metric = String(rule.params['metric'] ?? 'execution');
  const threshold = num(rule.params['threshold'], Infinity);
  const observed = await evaluateUsageMetric(client, { workspaceId: rule.workspaceId, metric, windowStart });
  if (observed < threshold) return null;
  return { type: 'usage_threshold', metric, observed, threshold, windowMinutes };
}
