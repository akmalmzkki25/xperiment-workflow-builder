import { appendAuditEvent, getQuotaUsage, getWorkspacePlan, setWorkspacePlan, withTx } from '@xperiment/db';
import {
  evaluateQuota,
  isBlocked,
  periodEnd,
  periodStart,
  PLAN_CODES,
  resolveLimits,
  type LimitKey,
  type PlanCode,
  type PlanLimits,
  type QuotaLine,
} from '@xperiment/plans';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

// Derived from the catalog, so the accepted codes can never drift from the plans that exist.
const planCodeSchema = z.enum(PLAN_CODES as [PlanCode, ...PlanCode[]]);
const updateSchema = z.object({ planCode: planCodeSchema.optional(), allowOverage: z.boolean().optional() }).strict();

export interface PlanSnapshot {
  planCode: PlanCode;
  allowOverage: boolean;
  limits: PlanLimits;
  usage: Record<LimitKey, number>;
  lines: QuotaLine[];
  period: { start: string; end: string };
}

/** Current plan, limits, usage and per-limit status for one workspace. */
export async function quotaSnapshot(pool: pg.Pool, workspaceId: string): Promise<PlanSnapshot> {
  const plan = await getWorkspacePlan(pool, workspaceId);
  const limits = resolveLimits(plan.planCode, plan.limitOverrides);
  const start = periodStart(new Date());
  const usage = await getQuotaUsage(pool, workspaceId, start);
  return {
    planCode: plan.planCode,
    allowOverage: plan.allowOverage,
    limits,
    usage,
    lines: evaluateQuota(limits, usage, plan.allowOverage),
    period: { start: start.toISOString(), end: periodEnd(start).toISOString() },
  };
}

/**
 * Refuse a stock-limited action with 402. Returns true when the caller should stop.
 * Flow limits are enforced in the DB chokepoint instead — this covers the actions that
 * grow a gauge (activating a workflow, adding a member, spending AI tokens).
 */
export async function quotaBlocks(
  pool: pg.Pool,
  reply: FastifyReply,
  workspaceId: string,
  metric: LimitKey,
): Promise<boolean> {
  const snap = await quotaSnapshot(pool, workspaceId);
  if (!isBlocked(snap.lines, metric)) return false;
  const line = snap.lines.find((l) => l.metric === metric)!;
  sendProblem(
    reply,
    402,
    'Quota exceeded',
    `${metric}: ${line.used} of ${line.limit} used. Upgrade the plan or enable overage.`,
  );
  return true;
}

export function registerPlanRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/plan', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:read')) return;
    return quotaSnapshot(deps.pool, ctx.workspaceId);
  });

  app.put('/v1/plan', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:manage')) return;
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid plan change', parsed.error.message);

    if (parsed.data.planCode) {
      // A downgrade must not strand a workspace above a stock limit it cannot shed
      // automatically — refuse rather than leave it permanently blocked.
      const start = periodStart(new Date());
      const usage = await getQuotaUsage(deps.pool, ctx.workspaceId, start);
      const next = resolveLimits(parsed.data.planCode, {});
      for (const metric of ['activeWorkflows', 'members'] as const) {
        const limit = next[metric];
        if (limit !== null && usage[metric] > limit) {
          return sendProblem(
            reply,
            409,
            'Plan too small',
            `${metric}: the workspace has ${usage[metric]}, and ${parsed.data.planCode} allows ${limit}.`,
          );
        }
      }
    }
    await withTx(deps.pool, async (client) => {
      // Read inside the transaction: setWorkspacePlan does not return the previous code,
      // and reading it outside would race a concurrent change.
      const before = await getWorkspacePlan(client, ctx.workspaceId);
      const after = await setWorkspacePlan(client, {
        workspaceId: ctx.workspaceId,
        ...(parsed.data.planCode ? { planCode: parsed.data.planCode } : {}),
        ...(parsed.data.allowOverage !== undefined ? { allowOverage: parsed.data.allowOverage } : {}),
      });
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'plan.change',
        targetType: 'workspace',
        targetId: ctx.workspaceId,
        metadata: { previousPlan: before.planCode, newPlan: after.planCode, allowOverage: after.allowOverage },
      });
    });
    return quotaSnapshot(deps.pool, ctx.workspaceId);
  });
}
