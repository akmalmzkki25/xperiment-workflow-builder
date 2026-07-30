import { listAuditEvents } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/**
 * Strict rather than lenient. There is no Fastify error handler in this app, so an
 * unvalidated `before` reaching a ::bigint parameter would surface the pg driver's
 * message as a 500. A digits-only cursor keeps it a 400.
 */
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
    before: z.string().regex(/^\d+$/).optional(),
    action: z.string().min(1).max(120).optional(),
    targetType: z.string().min(1).max(60).optional(),
    targetId: z.string().min(1).max(200).optional(),
  })
  .strict();

export function registerAuditRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/audit', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'audit:read')) return;
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid query', parsed.error.message);
    const { limit, before, action, targetType, targetId } = parsed.data;
    const items = await listAuditEvents(deps.pool, {
      workspaceId: ctx.workspaceId,
      limit,
      ...(before ? { before } : {}),
      ...(action ? { action } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
    });
    // A full page means there may be more; a short page is the end.
    const nextBefore = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    return { items, nextBefore };
  });
}
