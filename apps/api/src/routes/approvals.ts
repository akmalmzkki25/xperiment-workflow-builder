import { applyResume, getOpenApprovalWait, listOpenApprovals, withTx } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const decisionSchema = z
  .object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional() })
  .strict();
const listQuerySchema = z.object({ status: z.literal('open').default('open'), limit: z.coerce.number().int().min(1).max(100).default(20) });

export function registerApprovalRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/approvals', async (req, reply) => {
    const ctx = authOf(req);
    const q = listQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return sendProblem(reply, 400, 'Invalid query', q.error.message);
    return { items: await listOpenApprovals(deps.pool, { workspaceId: ctx.workspaceId, limit: q.data.limit }) };
  });

  app.post('/v1/executions/:id/approvals/:nodeId', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'approval:decide')) return;
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);

    // Scoped to the caller's workspace — cross-tenant decisions see no open wait.
    const wait = await getOpenApprovalWait(deps.pool, { executionId: id, nodeId, workspaceId: ctx.workspaceId });
    if (!wait) return sendProblem(reply, 404, 'No pending approval', 'This node has no open approval for your workspace');

    const outputPort = parsed.data.decision === 'approve' ? 'approved' : 'rejected';
    const resolved = await withTx(deps.pool, (client) =>
      applyResume(client, {
        wait: { id: wait.id, executionId: wait.executionId, nodeId: wait.nodeId, attempt: wait.attempt },
        waitStatus: 'resolved',
        terminal: 'SUCCEEDED',
        outputPort,
        output: {
          decision: parsed.data.decision,
          ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
          resolvedBy: ctx.userId,
          resolvedAt: new Date().toISOString(),
        },
        decision: parsed.data.decision,
        ...(ctx.userId ? { resolvedBy: ctx.userId } : {}),
        ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
      }),
    );
    // Lost a race with the expiry sweep or a concurrent decision.
    if (!resolved) return sendProblem(reply, 409, 'Approval already resolved');
    return { resolved: true, decision: parsed.data.decision };
  });
}
