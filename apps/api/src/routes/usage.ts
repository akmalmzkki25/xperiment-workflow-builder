import { getUsageSummary } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function registerUsageRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/usage', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid query', parsed.error.message);
    const now = new Date();
    const from = parsed.data.from ?? startOfUtcMonth(now);
    const to = parsed.data.to ?? now;
    if (from.getTime() >= to.getTime()) {
      return sendProblem(reply, 400, 'Invalid range', 'from must be before to');
    }
    return getUsageSummary(deps.pool, { workspaceId: authOf(req).workspaceId, from, to });
  });
}
