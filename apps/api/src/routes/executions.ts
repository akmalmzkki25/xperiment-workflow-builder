import { randomUUID } from 'node:crypto';
import {
  createExecutionWithTrigger,
  getExecutionDetail,
  getVersion,
  getWorkflow,
  listExecutions,
} from '@xperiment/db';
import { workflowIrSchema } from '@xperiment/ir';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, roleGate } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;

const listQuerySchema = z.object({
  workflowId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export function registerExecutionRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workflows/:id/execute', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    if (!wf.activeVersionId) {
      return sendProblem(reply, 409, 'No published version', 'Publish the workflow before executing it');
    }
    const version = await getVersion(deps.pool, wf.activeVersionId);
    if (!version) return sendProblem(reply, 409, 'Active version missing');
    const ir = workflowIrSchema.parse(version.definition);
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();

    const { execution, created } = await createExecutionWithTrigger(deps.pool, {
      workflowId: id,
      versionId: version.id,
      idempotencyKey,
      payload: req.body ?? null,
      nodeIds: ir.nodes.map((n) => n.id),
      executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    return reply.status(created ? 201 : 200).send({ executionId: execution.id, status: execution.status, created });
  });

  app.get('/v1/executions', async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return sendProblem(reply, 400, 'Invalid query', q.error.message);
    return listExecutions(deps.pool, {
      workspaceId: authOf(req).workspaceId,
      limit: q.data.limit,
      ...(q.data.workflowId ? { workflowId: q.data.workflowId } : {}),
      ...(q.data.cursor ? { cursor: q.data.cursor } : {}),
    });
  });

  app.get('/v1/executions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getExecutionDetail(deps.pool, id, authOf(req).workspaceId);
    if (!detail) return sendProblem(reply, 404, 'Execution not found');
    return detail;
  });
}
