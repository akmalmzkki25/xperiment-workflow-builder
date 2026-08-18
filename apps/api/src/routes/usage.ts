import { getUsageSummary } from '@xperiment/db';
import { billingPeriod } from '@xperiment/plans';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export function registerUsageRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/usage', async (req, reply) => {
    if (!requirePermission(reply, authOf(req), 'usage:read')) return;
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid query', parsed.error.message);
    const now = new Date();
    // The same period the invoice will be drawn on, so the two pages cannot disagree.
    const from = parsed.data.from ?? billingPeriod(now).startsAt;
    const to = parsed.data.to ?? now;
    if (from.getTime() >= to.getTime()) {
      return sendProblem(reply, 400, 'Invalid range', 'from must be before to');
    }
    return getUsageSummary(deps.pool, { workspaceId: authOf(req).workspaceId, from, to });
  });
}
