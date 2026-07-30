import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import { createOpenRouterClient, type ChatClient } from '@xperiment/ai';
import type { ConnectorRegistry } from '@xperiment/connectors';
import {
  createSecretVault,
  createWorkspaceKeyring,
  DEFAULT_LOCAL_KEK_MASTER,
  deriveLegacyKey,
  localKeyProvider,
  type KeyProvider,
  type SecretVault,
} from '@xperiment/db';
import { providerFor, type PaymentProvider } from '@xperiment/payments';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AiConfig } from './routes/deps.js';
import { registerAuthPlugin } from './auth/plugin.js';
import { registerRateLimit } from './rateLimit/plugin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerOpenapiRoutes } from './routes/openapi.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerTriggerRoutes } from './routes/triggers.js';
import { registerInvoiceRoutes } from './routes/invoices.js';
import { registerPlanRoutes } from './routes/plan.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export interface ServerDeps {
  pool: pg.Pool;
  registry: ConnectorRegistry;
  gatewayUrl?: string;
  triggerKey?: Buffer;
  credentialsKey?: Buffer;
  /**
   * Root key provider for envelope encryption. buildServer is synchronous and used
   * that way by every test, so it defaults to the local provider; the long-running
   * entrypoint resolves the async createKeyProviderFromEnv and passes the result here.
   */
  keyProvider?: KeyProvider;
  credentialsVault?: SecretVault;
  triggerVault?: SecretVault;
  ai?: AiConfig;
  aiClientFactory?: (cfg: { apiKey: string; model: string; baseUrl: string; appUrl?: string }) => ChatClient;
  rateLimitPerMinute?: number;
  paymentProvider?: PaymentProvider;
  paymentWebhookSecret?: string | null;
}

/** A typo must fail at startup, not silently disable payment on every request. */
function resolvePaymentProvider(override?: PaymentProvider): PaymentProvider {
  if (override) return override;
  const key = process.env['PAYMENT_PROVIDER'] ?? 'manual';
  const provider = providerFor(key);
  if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER: ${key}`);
  return provider;
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
  // One keyring for both vaults, so the split by legacy key family does not double
  // KMS traffic: one unwrap per workspace per cache window for the whole process.
  const keyring = createWorkspaceKeyring({
    pool: deps.pool,
    provider: deps.keyProvider ?? localKeyProvider(process.env['KEK_MASTER_KEY'] ?? DEFAULT_LOCAL_KEK_MASTER),
    ...(process.env['KEK_CACHE_TTL_MS'] ? { ttlMs: Number(process.env['KEK_CACHE_TTL_MS']) } : {}),
  });
  const resolvedDeps = {
    pool: deps.pool,
    registry: deps.registry,
    paymentProvider: resolvePaymentProvider(deps.paymentProvider),
    paymentWebhookSecret: deps.paymentWebhookSecret ?? process.env['PAYMENT_WEBHOOK_SECRET'] ?? null,
    gatewayUrl: deps.gatewayUrl ?? process.env['GATEWAY_URL'] ?? 'http://localhost:3003',
    triggerKey:
      deps.triggerKey ?? deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
    credentialsKey:
      deps.credentialsKey ??
      deriveLegacyKey(process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me'),
    credentialsVault:
      deps.credentialsVault ??
      createSecretVault({
        keyring,
        legacyKey: deriveLegacyKey(process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me'),
      }),
    triggerVault:
      deps.triggerVault ??
      createSecretVault({
        keyring,
        legacyKey: deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
      }),
    ai: resolveAiConfig(deps.ai),
    aiClientFactory: deps.aiClientFactory ?? createOpenRouterClient,
  };
  registerAuthPlugin(app, { pool: deps.pool });
  registerRateLimit(app, {
    perMinute: deps.rateLimitPerMinute ?? Number(process.env['RATE_LIMIT_PER_MIN'] ?? 600),
  });
  registerHealthRoutes(app);
  registerOpenapiRoutes(app);
  registerAuthRoutes(app, resolvedDeps);
  registerWorkspaceRoutes(app, resolvedDeps);
  registerWorkflowRoutes(app, resolvedDeps);
  registerExecutionRoutes(app, resolvedDeps);
  registerTriggerRoutes(app, resolvedDeps);
  registerConnectionRoutes(app, resolvedDeps);
  registerConnectorRoutes(app, resolvedDeps);
  registerAiRoutes(app, resolvedDeps);
  registerApprovalRoutes(app, resolvedDeps);
  registerUsageRoutes(app, resolvedDeps);
  registerPlanRoutes(app, resolvedDeps);
  registerInvoiceRoutes(app, resolvedDeps);
  registerAlertRoutes(app, resolvedDeps);
  registerAuditRoutes(app, resolvedDeps);
  registerTemplateRoutes(app, resolvedDeps);
  return app;
}
