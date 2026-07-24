import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import { createOpenRouterClient, type ChatClient } from '@xperiment/ai';
import type { ConnectorRegistry } from '@xperiment/connectors';
import { deriveTriggerKey } from '@xperiment/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AiConfig } from './routes/deps.js';
import { registerAuthPlugin } from './auth/plugin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerConnectorRoutes } from './routes/connectors.js';
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
  ai?: AiConfig;
  aiClientFactory?: (cfg: { apiKey: string; model: string; baseUrl: string; appUrl?: string }) => ChatClient;
}

function resolveAiConfig(override?: AiConfig): AiConfig {
  if (override) return override;
  const apiKey = process.env['OPENROUTER_API_KEY'];
  return {
    apiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    model: process.env['OPENROUTER_MODEL'] ?? 'google/gemini-3.1-flash-lite',
    baseUrl: process.env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai',
    ...(process.env['OPENROUTER_APP_URL'] ? { appUrl: process.env['OPENROUTER_APP_URL'] } : {}),
  };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  // Bearer-token auth (no cookies), so reflecting the origin is safe for the alpha.
  void app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'if-match', 'idempotency-key', 'x-xperiment-workspace'],
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
    ai: resolveAiConfig(deps.ai),
    aiClientFactory: deps.aiClientFactory ?? createOpenRouterClient,
  };
  registerAuthPlugin(app, { pool: deps.pool });
  registerHealthRoutes(app);
  registerAuthRoutes(app, resolvedDeps);
  registerWorkspaceRoutes(app, resolvedDeps);
  registerWorkflowRoutes(app, resolvedDeps);
  registerExecutionRoutes(app, resolvedDeps);
  registerTriggerRoutes(app, resolvedDeps);
  registerConnectionRoutes(app, resolvedDeps);
  registerConnectorRoutes(app, resolvedDeps);
  registerAiRoutes(app, resolvedDeps);
  return app;
}
