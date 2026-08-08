import { randomUUID } from 'node:crypto';
import {
  appendAuditEvent,
  appendEvent,
  casExecution,
  casNode,
  closeOpenWaits,
  createExecutionWithTrigger,
  enqueueCompletionCallback,
  getExecutionDetail,
  getTriggerPayload,
  getVersion,
  getWorkflow,
  latestNodeStates,
  listExecutions,
  recordExecutionUsage,
  waitsForExecution,
  withTx,
} from '@xperiment/db';
import type { QuotaRefusal } from '@xperiment/db';
import { runnableNodeIds, workflowIrSchema } from '@xperiment/ir';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
import { hasPermission } from '../auth/permissions.js';
import { sendProblem } from '../problem.js';
import { redactSecrets } from './redact.js';
import type { ResolvedServerDeps } from './deps.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;

/** 402: the request is well-formed and authorized, but the workspace has no budget for it. */
function sendQuotaProblem(reply: FastifyReply, refusal: QuotaRefusal): void {
  sendProblem(
    reply,
    402,
    'Quota exceeded',
    `${refusal.metric}: ${refusal.used} of ${refusal.limit} used this period. Upgrade the plan or enable overage.`,
  );
}

const listQuerySchema = z.object({
  workflowId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export function registerExecutionRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workflows/:id/execute', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'execution:run')) return;
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

    const result = await createExecutionWithTrigger(deps.pool, {
      workflowId: id,
      versionId: version.id,
      idempotencyKey,
      payload: req.body ?? null,
      nodeIds: runnableNodeIds(ir),
      executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    if (result.outcome === 'quota_exceeded') {
      sendQuotaProblem(reply, result);
      return;
    }
    const created = result.outcome === 'created';
    return reply
      .status(created ? 201 : 200)
      .send({ executionId: result.execution.id, status: result.execution.status, created });
  });

  app.get('/v1/executions', async (req, reply) => {
    if (!requirePermission(reply, authOf(req), 'execution:read')) return;
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
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'execution:read')) return;
    const { id } = req.params as { id: string };
    // Whoever may START a run may see the data that ran. A viewer is a read-only
    // observer, and handing it payloads would turn `execution:read` into a transitive
    // read of anything an author typed into a parameter. Same field-level shape as the
    // credential reveal on the triggers route.
    const canSeePayloads = hasPermission(ctx.role, 'execution:run');
    const detail = await getExecutionDetail(deps.pool, id, ctx.workspaceId, { includePayloads: canSeePayloads });
    if (!detail) return sendProblem(reply, 404, 'Execution not found');
    // Surface the resume URL for open event waits so an operator/external system
    // can discover the callback endpoint. Tokens are added deliberately here and
    // never by getExecutionDetail itself.
    // A resume URL is a bearer credential: POST /r/:resumeToken carries NO auth, so
    // whoever holds it can drive the run and write that node's output. Gate it with the
    // payloads — a viewer is denied execution:run precisely so it cannot drive a run —
    // and audit every reveal, exactly as the trigger-secret route does.
    const rows = canSeePayloads ? await waitsForExecution(deps.pool, id) : [];
    const openEventWaits = rows.filter((w) => w.status === 'open' && w.kind === 'event' && w.resumeToken);
    const resumeUrlByNode = new Map(openEventWaits.map((w) => [w.nodeId, `${deps.gatewayUrl}/r/${w.resumeToken}`]));
    for (const w of openEventWaits) {
      await appendAuditEvent(deps.pool, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'execution_resume.reveal',
        targetType: 'execution',
        targetId: id,
        metadata: { nodeId: w.nodeId },
      });
    }
    const waits = detail.waits.map((w) => ({
      ...w,
      ...(resumeUrlByNode.has(w.nodeId) ? { resumeUrl: resumeUrlByNode.get(w.nodeId) } : {}),
    }));
    const nodes = detail.nodes.map((n) => ({
      ...n,
      // errorJson is returned to EVERY role and is not author-typed: an http.request
      // failure carries the provider's full response body, and an SSRF refusal carries
      // the raw URL including any query-string credential. Redact it regardless.
      errorJson: redactSecrets(n.errorJson),
      ...(canSeePayloads
        ? { inputJson: redactSecrets(n.inputJson), outputJson: redactSecrets(n.outputJson) }
        : {}),
    }));
    // An explicit boolean, not the absence of a key: the UI has to be able to say
    // "payloads are visible to members who can run workflows" rather than implying the
    // node recorded nothing. Absent keys also vanish through JSON.stringify.
    return { ...detail, nodes, waits, payloadsVisible: canSeePayloads };
  });

  const TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'];

  app.post('/v1/executions/:id/cancel', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'execution:cancel')) return;
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
      await enqueueCompletionCallback(client, { workflowId: detail.execution.workflowId, executionId: id });
      await recordExecutionUsage(client, {
        workspaceId: ctx.workspaceId,
        workflowId: detail.execution.workflowId,
        executionId: id,
        status: 'CANCELED',
        nodeCount: states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
        computeMs: detail.execution.startedAt ? Date.now() - new Date(detail.execution.startedAt).getTime() : 0,
        occurredAt: new Date(),
      });
    });
    return { status: 'CANCELED' };
  });

  app.post('/v1/executions/:id/retry', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'execution:run')) return;
    const { id } = req.params as { id: string };
    const detail = await getExecutionDetail(deps.pool, id, ctx.workspaceId);
    if (!detail) return sendProblem(reply, 404, 'Execution not found');
    const version = await getVersion(deps.pool, detail.execution.workflowVersionId);
    if (!version) return sendProblem(reply, 409, 'Original version missing');
    const ir = workflowIrSchema.parse(version.definition);
    const payload = await getTriggerPayload(deps.pool, id);
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
    const result = await createExecutionWithTrigger(deps.pool, {
      workflowId: detail.execution.workflowId,
      versionId: version.id,
      idempotencyKey,
      payload,
      nodeIds: runnableNodeIds(ir),
      executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    if (result.outcome === 'quota_exceeded') {
      sendQuotaProblem(reply, result);
      return;
    }
    const created = result.outcome === 'created';
    return reply
      .status(created ? 201 : 200)
      .send({ executionId: result.execution.id, status: result.execution.status, created });
  });
}
