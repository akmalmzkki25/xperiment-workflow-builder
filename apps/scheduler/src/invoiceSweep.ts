import {
  DEFAULT_INVOICE_BATCH,
  getQuotaUsage,
  getWorkspacePlan,
  issueInvoice,
  workspacesNeedingInvoice,
} from '@xperiment/db';
import { buildInvoice, DEFAULT_TAX_RATE_BPS, previousPeriod, resolveLimits } from '@xperiment/plans';
import type pg from 'pg';

export interface InvoiceSweepDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Workspaces to close per tick. The remainder drains on the next one. */
  batchSize?: number;
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
export async function runInvoiceSweep(deps: InvoiceSweepDeps): Promise<{ issued: number; capped: boolean }> {
  const period = previousPeriod(new Date());
  const batchSize = deps.batchSize ?? DEFAULT_INVOICE_BATCH;
  const due = await workspacesNeedingInvoice(deps.pool, period, batchSize);
  let issued = 0;

  for (const { workspaceId } of due) {
    try {
      const plan = await getWorkspacePlan(deps.pool, workspaceId);
      const limits = resolveLimits(plan.planCode, plan.limitOverrides);
      const usage = await getQuotaUsage(deps.pool, workspaceId, period.key);
      const draft = buildInvoice({ planCode: plan.planCode, limits, usage, taxRateBps: taxRateBps() });
      const invoice = await issueInvoice(deps.pool, {
        workspaceId,
        period,
        planCode: plan.planCode,
        draft,
      });
      if (invoice) issued += 1;
    } catch (e) {
      // One workspace must never stall the batch for every other one. `issueInvoice`
      // owns its own transaction, so there is no enclosing one to protect with a
      // savepoint — the catch is the isolation boundary.
      deps.log('invoice_sweep.workspace_failed', { workspaceId, err: (e as Error).message });
    }
  }

  // A full batch means there is more waiting. Saying so turns a tick that quietly runs
  // long into a visible line naming the real condition.
  const capped = due.length === batchSize;
  if (capped) deps.log('invoice_sweep.backlog_capped', { batchSize, period: period.key });
  if (issued) deps.log('invoice_sweep.done', { issued, period: period.key });
  return { issued, capped };
}
