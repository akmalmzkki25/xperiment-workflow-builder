import { randomUUID } from 'node:crypto';
import type { ConnectorRegistry } from '@xperiment/connectors';
import { deriveTriggerKey } from '@xperiment/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerAuthPlugin } from './auth/plugin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTriggerRoutes } from './routes/triggers.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export interface ServerDeps {
  pool: pg.Pool;
  registry: ConnectorRegistry;
  gatewayUrl?: string;
  triggerKey?: Buffer;
  credentialsKey?: Buffer;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  const resolvedDeps = {
    pool: deps.pool,
    registry: deps.registry,
    gatewayUrl: deps.gatewayUrl ?? process.env['GATEWAY_URL'] ?? 'http://localhost:3003',
    triggerKey:
      deps.triggerKey ?? deriveTriggerKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
    credentialsKey:
      deps.credentialsKey ??
      deriveTriggerKey(process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me'),
  };
  registerAuthPlugin(app, { pool: deps.pool });
  registerHealthRoutes(app);
  registerAuthRoutes(app, resolvedDeps);
  registerWorkspaceRoutes(app, resolvedDeps);
  registerWorkflowRoutes(app, resolvedDeps);
  registerExecutionRoutes(app, resolvedDeps);
  registerTriggerRoutes(app, resolvedDeps);
  registerConnectionRoutes(app, resolvedDeps);
  return app;
}
