import { randomUUID } from 'node:crypto';
import {
  appendEvent,
  casExecution,
  casNode,
  closeOpenWaits,
  createExecutionWithTrigger,
  getExecutionDetail,
  getTriggerPayload,
  getVersion,
  getWorkflow,
  latestNodeStates,
  listExecutions,
  waitsForExecution,
  withTx,
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
    // Surface the resume URL for open event waits so an operator/external system
    // can discover the callback endpoint. Tokens are added deliberately here and
    // never by getExecutionDetail itself.
    const rows = await waitsForExecution(deps.pool, id);
    const resumeUrlByNode = new Map(
      rows
        .filter((w) => w.status === 'open' && w.kind === 'event' && w.resumeToken)
        .map((w) => [w.nodeId, `${deps.gatewayUrl}/r/${w.resumeToken}`]),
    );
    const waits = detail.waits.map((w) => ({
      ...w,
      ...(resumeUrlByNode.has(w.nodeId) ? { resumeUrl: resumeUrlByNode.get(w.nodeId) } : {}),
    }));
    return { ...detail, waits };
  });

  const TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'];

  app.post('/v1/executions/:id/cancel', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const { id } = req.params as { id: string };
    const detail = await getExecutionDetail(deps.pool, id, ctx.workspaceId);
    if (!detail) return sendProblem(reply, 404, 'Execution not found');
    if (TERMINAL.includes(detail.execution.status)) {
      return sendProblem(reply, 409, 'Execution already finished', `Status is ${detail.execution.status}`);
    }
    await withTx(deps.pool, async (client) => {
      const canceled = await casExecution(client, {
        executionId: id,
        from: ['CREATED', 'QUEUED', 'RUNNING'],
        to: 'CANCELED',
        completedAt: true,
        errorSummary: 'Canceled',
      });
      if (!canceled) return; // raced to terminal — leave it
      const states = await latestNodeStates(client, id);
      for (const s of states) {
        if (['PENDING', 'READY', 'QUEUED', 'RUNNING', 'WAITING'].includes(s.status)) {
          const ok = await casNode(client, {
            executionId: id,
            nodeId: s.nodeId,
            attempt: s.attempt,
            from: ['PENDING', 'READY', 'QUEUED', 'RUNNING', 'WAITING'],
            to: 'SKIPPED',
            patch: { completedAt: true },
          });
          if (ok) await appendEvent(client, { executionId: id, eventType: 'node.skipped', nodeId: s.nodeId });
        }
      }
      await closeOpenWaits(client, id);
      await appendEvent(client, { executionId: id, eventType: 'execution.canceled' });
    });
    return { status: 'CANCELED' };
  });

  app.post('/v1/executions/:id/retry', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const { id } = req.params as { id: string };
    const detail = await getExecutionDetail(deps.pool, id, ctx.workspaceId);
    if (!detail) return sendProblem(reply, 404, 'Execution not found');
    const version = await getVersion(deps.pool, detail.execution.workflowVersionId);
    if (!version) return sendProblem(reply, 409, 'Original version missing');
    const ir = workflowIrSchema.parse(version.definition);
    const payload = await getTriggerPayload(deps.pool, id);
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
    const { execution, created } = await createExecutionWithTrigger(deps.pool, {
      workflowId: detail.execution.workflowId,
      versionId: version.id,
      idempotencyKey,
      payload,
      nodeIds: ir.nodes.map((n) => n.id),
      executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    return reply.status(created ? 201 : 200).send({ executionId: execution.id, status: execution.status, created });
  });
}
