import { randomUUID } from 'node:crypto';
import {
  appendAuditEvent,
  appendEvent,
  casExecution,
  casNode,
  closeOpenWaits,
  createExecutionWithTrigger,
  enqueueCompletionCallback,
  CursorError,
  getExecutionDetail,
  getNodePayload,
  getTriggerPayload,
  getVersion,
  getWorkflow,
  latestNodeStates,
  listExecutions,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  searchExecutionsByPayload,
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

/** The statuses an execution can hold. Enumerated so a typo is a 400, not an empty page. */
const EXECUTION_STATUSES = [
  'CREATED',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELED',
] as const;

const listQuerySchema = z.object({
  workflowId: z.string().uuid().optional(),
  // Comma-separated so `?status=FAILED,TIMED_OUT` works — which is what an operator
  // actually wants when they are looking for problems, rather than two separate looks.
  status: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.split(',').map((s) => s.trim())))
    .pipe(z.array(z.enum(EXECUTION_STATUSES)).min(1).max(EXECUTION_STATUSES.length).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

/**
 * `status` defaults to the two failure states, and cannot be empty.
 *
 * "Retry everything" has no honest meaning — re-running a success duplicates work that
 * already happened, and a caller who omits the filter almost certainly meant the failures.
 */
const bulkRetrySchema = z
  .object({
    workflowId: z.string().uuid().optional(),
    status: z
      .array(z.enum(EXECUTION_STATUSES))
      .min(1)
      .max(EXECUTION_STATUSES.length)
      .default(['FAILED', 'TIMED_OUT']),
    // Capped: an unbounded bulk re-run is a way to replay a month of work with one click.
    limit: z.number().int().min(1).max(100).default(25),
    dryRun: z.boolean().default(false),
  })
  .strict();

/**
 * The minimum is MEASURED, not chosen for tidiness.
 *
 * A trigram is three consecutive characters. At two, Postgres cannot use the payload
 * index at all and sequentially scans every webhook body in the table — a scan a user
 * could ask for by typing two letters. Refused as a 400 rather than served slowly.
 */
const searchQuerySchema = z.object({
  q: z.string().trim().min(MIN_SEARCH_LENGTH).max(MAX_SEARCH_LENGTH),
  limit: z.coerce.number().int().min(1).max(50).default(20),
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
    try {
      return await listExecutions(deps.pool, {
        workspaceId: authOf(req).workspaceId,
        limit: q.data.limit,
        ...(q.data.workflowId ? { workflowId: q.data.workflowId } : {}),
        ...(q.data.status ? { status: q.data.status } : {}),
        ...(q.data.cursor ? { cursor: q.data.cursor } : {}),
      });
    } catch (e) {
      // A cursor minted under a different filter would otherwise return the page of
      // UNFILTERED rows after that position: no error, no empty result, just the wrong
      // set. Saying so lets the caller drop the cursor and start over.
      if (e instanceof CursorError) return sendProblem(reply, 400, 'Invalid cursor', e.message);
      throw e;
    }
  });

  /**
   * Find a run by what was in the body that started it.
   *
   * Gated on `execution:run`, the same permission as reading a node payload, and for the
   * same reason: a viewer is a read-only observer, and substring-probing customer data
   * would turn `execution:read` into a transitive read of every webhook body.
   *
   * Registered BEFORE `/v1/executions/:id` — Fastify's router prefers the static segment,
   * but keeping them in this order makes that independent of router behaviour.
   */
  app.get('/v1/executions/search', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'execution:run')) return;
    const q = searchQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return sendProblem(reply, 400, 'Invalid query', q.error.message);
    return {
      items: await searchExecutionsByPayload(deps.pool, {
        workspaceId: ctx.workspaceId,
        query: q.data.q,
        limit: q.data.limit,
      }),
    };
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
    // Payloads are NOT in this response. It has no row limit — a loop of 1000 iterations
    // times 10 attempts is thousands of rows at up to 512 KiB each — and the UI polls it
    // every two seconds while the run is live. They are fetched one at a time below.
    const detail = await getExecutionDetail(deps.pool, id, ctx.workspaceId);
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
    }));
    // An explicit boolean, not the absence of a key: the UI has to be able to say
    // "payloads are visible to members who can run workflows" rather than implying the
    // node recorded nothing. Absent keys also vanish through JSON.stringify.
    return { ...detail, nodes, waits, payloadsVisible: canSeePayloads };
  });

  const payloadParams = z.object({
    id: z.string().uuid(),
    nodeId: z.string().min(1).max(128),
    attempt: z.coerce.number().int().min(1).max(100),
  });

  app.get('/v1/executions/:id/nodes/:nodeId/:attempt/payload', async (req, reply) => {
    const ctx = authOf(req);
    // Whoever may START a run may see the data that ran. A viewer is a read-only
    // observer, and handing it payloads would turn `execution:read` into a transitive
    // read of anything an author typed into a parameter.
    if (!requirePermission(reply, ctx, 'execution:run')) return;
    const p = payloadParams.safeParse(req.params);
    if (!p.success) return sendProblem(reply, 400, 'Invalid path', p.error.message);
    const row = await getNodePayload(deps.pool, {
      executionId: p.data.id,
      nodeId: p.data.nodeId,
      attempt: p.data.attempt,
      workspaceId: ctx.workspaceId,
    });
    if (!row) return sendProblem(reply, 404, 'Node attempt not found');
    return { inputJson: redactSecrets(row.inputJson), outputJson: redactSecrets(row.outputJson) };
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

  /**
   * Re-run one execution against the version it originally ran.
   *
   * Shared by the single and the bulk route so they cannot drift: a bulk retry that
   * reproduced runs differently from the button beside them would be worse than no bulk
   * retry at all.
   */
  type RetryOutcome =
    | { kind: 'created'; executionId: string; status: string }
    | { kind: 'deduped'; executionId: string; status: string }
    | { kind: 'version_missing' }
    | { kind: 'quota_exceeded'; refusal: QuotaRefusal };

  async function retryOne(
    workspaceId: string,
    id: string,
    idempotencyKey: string,
  ): Promise<RetryOutcome | null> {
    const detail = await getExecutionDetail(deps.pool, id, workspaceId);
    if (!detail) return null;
    const version = await getVersion(deps.pool, detail.execution.workflowVersionId);
    // A version pruned or rolled away is a skip, not a batch failure: one unreplayable
    // run must not stop the ninety-nine that can be replayed.
    if (!version) return { kind: 'version_missing' };
    const ir = workflowIrSchema.parse(version.definition);
    const payload = await getTriggerPayload(deps.pool, id);
    const result = await createExecutionWithTrigger(deps.pool, {
      workflowId: detail.execution.workflowId,
      versionId: version.id,
      idempotencyKey,
      payload,
      nodeIds: runnableNodeIds(ir),
      executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    if (result.outcome === 'quota_exceeded') return { kind: 'quota_exceeded', refusal: result };
    return {
      kind: result.outcome === 'created' ? 'created' : 'deduped',
      executionId: result.execution.id,
      status: result.execution.status,
    };
  }

  app.post('/v1/executions/:id/retry', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'execution:run')) return;
    const { id } = req.params as { id: string };
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
    const outcome = await retryOne(ctx.workspaceId, id, idempotencyKey);
    if (outcome === null) return sendProblem(reply, 404, 'Execution not found');
    if (outcome.kind === 'version_missing') return sendProblem(reply, 409, 'Original version missing');
    if (outcome.kind === 'quota_exceeded') {
      sendQuotaProblem(reply, outcome.refusal);
      return;
    }
    const created = outcome.kind === 'created';
    return reply
      .status(created ? 201 : 200)
      .send({ executionId: outcome.executionId, status: outcome.status, created });
  });

  /**
   * Re-run every failure matching a filter.
   *
   * The operational shape this exists for: a provider token expires, forty runs fail over
   * a weekend, somebody rotates the credential on Monday and needs those forty back —
   * without opening forty tabs.
   *
   * Three constraints, each because a bulk re-run spends real money and real rate limit:
   *
   *  - `dryRun` first. The count is the thing an operator needs before committing, and it
   *    costs one query.
   *  - Hard-capped per call. An unbounded "retry everything" is a way to replay a month
   *    of work with one click.
   *  - Stops at the first quota refusal and REPORTS the partial. Quietly doing 43 of 100
   *    and answering 200 would be a lie the operator only discovers from the invoice.
   */
  app.post('/v1/executions/retry', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'execution:run')) return;
    const parsed = bulkRetrySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);

    const candidates = await listExecutions(deps.pool, {
      workspaceId: ctx.workspaceId,
      status: parsed.data.status,
      limit: parsed.data.limit,
      ...(parsed.data.workflowId ? { workflowId: parsed.data.workflowId } : {}),
    });

    if (parsed.data.dryRun) {
      return { dryRun: true, matched: candidates.items.length, retried: 0, skipped: 0, stoppedForQuota: false };
    }

    let retried = 0;
    let skipped = 0;
    let stoppedForQuota = false;
    // Oldest first, so a partial batch replays the backlog in the order it happened.
    for (const execution of [...candidates.items].reverse()) {
      const outcome = await retryOne(ctx.workspaceId, execution.id, randomUUID());
      if (outcome === null || outcome.kind === 'version_missing') {
        skipped += 1;
        continue;
      }
      if (outcome.kind === 'quota_exceeded') {
        stoppedForQuota = true;
        break;
      }
      retried += 1;
    }

    // One row for the batch, not one per execution — the same reasoning as the rekey
    // backfill. Per-run rows would bury the fact that a human did this once, deliberately.
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      workspaceId: ctx.workspaceId,
      action: 'execution.retry_batch',
      outcome: stoppedForQuota ? 'failure' : 'success',
      metadata: {
        matched: candidates.items.length,
        retried,
        skipped,
        stoppedForQuota,
        // Joined: audit metadata holds scalars, and the reader wants the filter as one
        // readable string anyway.
        status: parsed.data.status.join(','),
        ...(parsed.data.workflowId ? { workflowId: parsed.data.workflowId } : {}),
      },
    });

    return { dryRun: false, matched: candidates.items.length, retried, skipped, stoppedForQuota };
  });
}
