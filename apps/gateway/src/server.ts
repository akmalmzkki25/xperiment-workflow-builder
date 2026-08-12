import { createHash, randomUUID } from 'node:crypto';
import {
  applyResume,
  createExecutionWithTrigger,
  getOpenWaitByToken,
  getTriggerByRouteKey,
  getVersion,
  getWorkflow,
  headersSeen,
  PAYLOAD_CAP_BYTES,
  PayloadTooLargeError,
  recordDelivery,
  withTx,
  type DeliveryOutcome,
  type SecretVault,
} from '@xperiment/db';
import { runnableNodeIds, workflowIrSchema } from '@xperiment/ir';
import { createReadiness, postgresDependency } from '@xperiment/observability';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import {
  extractDedupKey,
  parseHandshake,
  sanitizeHeaders,
  verifyCallbackToken,
  verifyHmac,
  verifyMetaSignature,
  verifyMidtransSignature,
  verifyToken,
} from './verify.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;
const RESUME_BODY_CAP_BYTES = 262144; // matches the node output cap in @xperiment/db

export interface GatewayDeps {
  pool: pg.Pool;
  triggerVault: SecretVault;
}

export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    // Matched to the storage cap, not chosen independently. At 1 MB, anything between
    // 256 KB and 1 MB passed Fastify and then threw inside createExecutionWithTrigger,
    // and with no error handler the provider got a 500 — which most providers retry,
    // forever, on a body that can never be stored.
    bodyLimit: PAYLOAD_CAP_BYTES,
    genReqId: () => randomUUID(),
  });
  // Keep raw bytes for HMAC; parse JSON manually.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, payload, done) => {
    done(null, payload);
  });

  /**
   * A payload the database will not accept is the CALLER's problem, not ours.
   *
   * `bodyLimit` above rejects the clearly-oversized before we buffer anything, but the
   * stored payload wraps the body with headers and query, so a body just under the cap
   * can still overflow once wrapped. Reported as 413 either way: a 500 tells a provider
   * to try again, and it will, on a body that can never be stored.
   */
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof PayloadTooLargeError) {
      return reply.status(413).send({ title: 'Payload Too Large', status: 413 });
    }
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    // Never relay the message on a 5xx: it can carry connection strings and query text.
    if (status >= 500) return reply.status(status).send({ title: 'Internal Server Error', status });
    return reply
      .status(status)
      .send({ title: typeof e.message === 'string' ? e.message : 'Request rejected', status });
  });

  // Liveness: touches nothing, so a database blip cannot restart the fleet.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: Postgres is critical here — a gateway that cannot write a trigger event
  // must stop being sent webhooks rather than accept and drop them.
  const readiness = createReadiness([postgresDependency(deps.pool)]);
  app.get('/readyz', async (_req, reply) => {
    const report = await readiness();
    if (report.status === 'down') reply.status(503);
    return report;
  });

  const secretFor = async (trigger: {
    workspaceId: string;
    secretEncrypted: Buffer | null;
    secretEncVersion: number;
  }): Promise<string> =>
    trigger.secretEncrypted
      ? deps.triggerVault.decrypt(trigger.workspaceId, {
          blob: trigger.secretEncrypted,
          encVersion: trigger.secretEncVersion,
        })
      : '';

  /**
   * Meta's subscription handshake, and NOTHING else.
   *
   * A separate handler rather than a method branch inside `handle`, because the one thing
   * this route must never do is start an execution. A GET that triggered a run would fire
   * on any crawler, link preview or browser prefetch that touched the URL — and webhook
   * URLs end up pasted into chat apps that fetch them automatically.
   *
   * Every failure is 404, never 401. A distinguishable failure would let someone sweep
   * route keys and learn which exist without authenticating.
   */
  const handshake = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { routeKey } = req.params as { routeKey: string };
    const trigger = await getTriggerByRouteKey(deps.pool, routeKey);
    if (!trigger) return reply.status(404).send({ title: 'Not found', status: 404 });
    const wf = await getWorkflow(deps.pool, trigger.workflowId);
    if (!wf?.activeVersionId) return reply.status(404).send({ title: 'Not found', status: 404 });

    const challenge = parseHandshake(req.query, await secretFor(trigger));
    if (challenge === null) return reply.status(404).send({ title: 'Not found', status: 404 });
    // Plain text, verbatim: Meta compares the body byte for byte and a JSON wrapper fails
    // the subscription with no useful error.
    return reply.status(200).type('text/plain; charset=utf-8').send(challenge);
  };

  const handle =
    (mode: 'production' | 'test') =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { routeKey } = req.params as { routeKey: string };
      const trigger = await getTriggerByRouteKey(deps.pool, routeKey);
      if (!trigger) return reply.status(404).send({ title: 'Not found', status: 404 });

      const wf = await getWorkflow(deps.pool, trigger.workflowId);
      if (!wf?.activeVersionId) return reply.status(404).send({ title: 'Not found', status: 404 });
      if (mode === 'production' && (!trigger.active || !wf.active)) {
        return reply.status(404).send({ title: 'Not found', status: 404 });
      }

      const rawBody = (req.body as Buffer | undefined) ?? Buffer.alloc(0);

      /**
       * Record what happened, then answer.
       *
       * Never the body: a rejected delivery is unauthenticated input, and storing it
       * would let anyone holding a route key write arbitrary content into the database
       * and onto an operator's screen. Never header values either — those are the
       * signatures. Only which diagnostic header NAMES arrived, which is the whole
       * diagnostic: "you sent x-xperiment-signature, this trigger expects x-hub-signature-256".
       *
       * Best-effort: a delivery that cannot be logged must still be answered, so a
       * diagnostic write never becomes the reason a webhook fails.
       */
      const note = async (
        outcome: DeliveryOutcome,
        statusCode: number,
        executionId?: string,
      ): Promise<void> => {
        try {
          await recordDelivery(deps.pool, {
            workspaceId: trigger.workspaceId,
            workflowId: trigger.workflowId,
            triggerId: trigger.id,
            nodeId: trigger.nodeId,
            mode,
            outcome,
            statusCode,
            authMode: trigger.authMode,
            headersSeen: headersSeen(req.headers as Record<string, unknown>),
            bodyBytes: rawBody.length,
            ...(executionId === undefined ? {} : { executionId }),
          });
        } catch (e) {
          req.log.warn({ err: e }, 'delivery.record_failed');
        }
      };

      let body: unknown = null;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          await note('invalid_json', 400);
          return reply.status(400).send({ title: 'Invalid JSON body', status: 400 });
        }
      }

      if (trigger.authMode !== null && trigger.authMode !== 'none') {
        const secret = await secretFor(trigger);
        const header = (name: string): string | undefined => req.headers[name] as string | undefined;
        // Midtrans is the odd one: its digest lives in the parsed body, so this check has
        // to happen after JSON parsing rather than on the raw bytes like the others.
        const ok =
          trigger.authMode === 'token'
            ? verifyToken(req.headers['authorization'], secret)
            : trigger.authMode === 'hmac'
              ? verifyHmac(header('x-xperiment-signature'), secret, rawBody)
              : trigger.authMode === 'meta'
                ? verifyMetaSignature(header('x-hub-signature-256'), secret, rawBody)
                : trigger.authMode === 'xendit'
                  ? verifyCallbackToken(header('x-callback-token'), secret)
                  : trigger.authMode === 'midtrans'
                    ? verifyMidtransSignature(body, secret)
                    : // An authMode nobody implemented fails closed. Falling through as
                      // "no auth required" would turn a typo into an open endpoint.
                      false;
        if (!ok) {
          // The one that matters most. Before this, a provider signing under the wrong
          // header got a 401 and left no trace anywhere the operator could look.
          await note('unauthorized', 401);
          return reply.status(401).send({ title: 'Unauthorized', status: 401 });
        }
      }

      const dedupKey =
        extractDedupKey(body, trigger.idempotencyKeyPath) ??
        (req.headers['idempotency-key'] as string | undefined) ??
        createHash('sha256').update(rawBody).digest('hex');

      const version = await getVersion(deps.pool, wf.activeVersionId);
      if (!version) return reply.status(404).send({ title: 'Not found', status: 404 });
      const ir = workflowIrSchema.parse(version.definition);

      const result = await createExecutionWithTrigger(deps.pool, {
        workflowId: trigger.workflowId,
        versionId: version.id,
        idempotencyKey: `${mode === 'test' ? 'test:' : ''}${dedupKey}`,
        payload: {
          body,
          headers: sanitizeHeaders(req.headers as Record<string, unknown>),
          query: req.query ?? {},
        },
        nodeIds: runnableNodeIds(ir),
        executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
        // Which trigger node received this, so the sample viewer can scope to it.
        triggerNodeId: trigger.nodeId,
      });
      if (result.outcome === 'quota_exceeded') {
        // The response stays deliberately generic — an unauthenticated caller must not
        // learn the workspace's plan state — but the OWNER gets to see it here, which is
        // the difference between "webhooks stopped working" and "we hit the plan cap".
        await note('quota_exceeded', 429);
        return reply.status(429).send({ title: 'Too Many Requests', status: 429 });
      }
      const created = result.outcome === 'created';
      if (created && mode === 'test') {
        await deps.pool.query(`UPDATE executions SET mode = 'test' WHERE id = $1`, [result.execution.id]);
      }
      // A repeat delivery is recorded as such rather than as a second acceptance: an
      // operator seeing one execution for five deliveries needs to know why.
      await note(created ? 'accepted' : 'duplicate', created ? 202 : 200, result.execution.id);
      return reply.status(created ? 202 : 200).send({ executionId: result.execution.id, created });
    };

  app.post('/t/test/:routeKey', handle('test'));
  app.post('/t/:routeKey', handle('production'));
  // Handshake only. `handshake` cannot start an execution — that is the whole reason it
  // is a separate function rather than a branch inside `handle`.
  app.get('/t/:routeKey', handshake);

  // Resume a waitForEvent node. The token is the secret (like a route key), so
  // no auth header is required; a single-use token resolves the open event wait.
  app.post('/r/:resumeToken', async (req: FastifyRequest, reply: FastifyReply) => {
    const { resumeToken } = req.params as { resumeToken: string };
    const wait = await getOpenWaitByToken(deps.pool, resumeToken);
    if (!wait || wait.kind !== 'event') return reply.status(404).send({ title: 'Not found', status: 404 });

    const rawBody = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    // The body becomes the node output, which is capped at 256KB — reject early
    // with 413 rather than letting the storage cap throw a 500 mid-transaction.
    if (rawBody.length > RESUME_BODY_CAP_BYTES) {
      return reply.status(413).send({ title: 'Payload too large', status: 413 });
    }
    let body: unknown = null;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return reply.status(400).send({ title: 'Invalid JSON body', status: 400 });
      }
    }

    const resumed = await withTx(deps.pool, (client) =>
      applyResume(client, {
        wait: { id: wait.id, executionId: wait.executionId, nodeId: wait.nodeId, attempt: wait.attempt },
        waitStatus: 'resolved',
        terminal: 'SUCCEEDED',
        outputPort: 'main',
        output: body,
      }),
    );
    if (!resumed) return reply.status(404).send({ title: 'Not found', status: 404 });
    return reply.status(200).send({ resumed: true });
  });

  return app;
}
