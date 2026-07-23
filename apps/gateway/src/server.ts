import { createHash, randomUUID } from 'node:crypto';
import {
  createExecutionWithTrigger,
  decryptSecret,
  getTriggerByRouteKey,
  getVersion,
  getWorkflow,
} from '@xperiment/db';
import { workflowIrSchema } from '@xperiment/ir';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { extractDedupKey, sanitizeHeaders, verifyHmac, verifyToken } from './verify.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;

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

      const { execution, created } = await createExecutionWithTrigger(deps.pool, {
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
      if (created && mode === 'test') {
        await deps.pool.query(`UPDATE executions SET mode = 'test' WHERE id = $1`, [execution.id]);
      }
      return reply.status(created ? 202 : 200).send({ executionId: execution.id, created });
    };

  app.post('/t/test/:routeKey', handle('test'));
  app.post('/t/:routeKey', handle('production'));
  return app;
}
