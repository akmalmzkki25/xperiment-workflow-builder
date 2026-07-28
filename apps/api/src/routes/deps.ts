export type { ServerDeps } from '../server.js';

export interface AiConfig {
  apiKey: string | null;
  model: string;
  /** Origin only, e.g. https://openrouter.ai */
  baseUrl: string;
  appUrl?: string;
}

export interface ResolvedServerDeps {
  pool: import('pg').Pool;
  registry: import('@xperiment/connectors').ConnectorRegistry;
  paymentProvider: import('@xperiment/payments').PaymentProvider;
  /** Null disables the webhook route entirely — it 401s rather than verifying against ''. */
  paymentWebhookSecret: string | null;
  gatewayUrl: string;
  triggerKey: Buffer;
  credentialsKey: Buffer;
  ai: AiConfig;
  aiClientFactory: (cfg: {
    apiKey: string;
    model: string;
    baseUrl: string;
    appUrl?: string;
  }) => import('@xperiment/ai').ChatClient;
}
