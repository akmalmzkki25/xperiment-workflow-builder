import { randomUUID } from 'node:crypto';
import type { ConnectorRegistry } from '@xperiment/connectors';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWorkflowRoutes } from './routes/workflows.js';

export interface ServerDeps {
  pool: pg.Pool;
  registry: ConnectorRegistry;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  registerHealthRoutes(app);
  registerWorkflowRoutes(app, deps);
  registerExecutionRoutes(app, deps);
  return app;
}
