import { createHash, randomUUID } from 'node:crypto';
import {
  applyResume,
  createExecutionWithTrigger,
  decryptSecret,
  getOpenWaitByToken,
  getTriggerByRouteKey,
  getVersion,
  getWorkflow,
  withTx,
} from '@xperiment/db';
import { workflowIrSchema } from '@xperiment/ir';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { extractDedupKey, sanitizeHeaders, verifyHmac, verifyToken } from './verify.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;
const RESUME_BODY_CAP_BYTES = 262144; // matches the node output cap in @xperiment/db

export interface GatewayDeps {
  pool: pg.Pool;
  triggerKey: Buffer;
}

export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
  });
  // Keep raw bytes for HMAC; parse JSON manually.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, payload, done) => {
    done(null, payload);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

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
      if (trigger.authMode === 'token' || trigger.authMode === 'hmac') {
        const secret = trigger.secretEncrypted ? decryptSecret(trigger.secretEncrypted, deps.triggerKey) : '';
        const ok =
          trigger.authMode === 'token'
            ? verifyToken(req.headers['authorization'], secret)
            : verifyHmac(req.headers['x-xperiment-signature'] as string | undefined, secret, rawBody);
        if (!ok) return reply.status(401).send({ title: 'Unauthorized', status: 401 });
      }

      let body: unknown = null;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return reply.status(400).send({ title: 'Invalid JSON body', status: 400 });
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
        nodeIds: ir.nodes.map((n) => n.id),
        executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      });
      if (result.outcome === 'quota_exceeded') {
        // Deliberately generic: an unauthenticated caller must not learn the
        // workspace's plan state from a webhook response.
        return reply.status(429).send({ title: 'Too Many Requests', status: 429 });
      }
      const created = result.outcome === 'created';
      if (created && mode === 'test') {
        await deps.pool.query(`UPDATE executions SET mode = 'test' WHERE id = $1`, [result.execution.id]);
      }
      return reply.status(created ? 202 : 200).send({ executionId: result.execution.id, created });
    };

  app.post('/t/test/:routeKey', handle('test'));
  app.post('/t/:routeKey', handle('production'));

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
