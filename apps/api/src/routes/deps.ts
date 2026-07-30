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
  /** Legacy global keys. Removed once every call site reads through a vault. */
  triggerKey: Buffer;
  credentialsKey: Buffer;
  /** Envelope encryption for connection payloads. Replaces credentialsKey. */
  credentialsVault: import('@xperiment/db').SecretVault;
  /** Envelope encryption for trigger, callback and alert webhook secrets. */
  triggerVault: import('@xperiment/db').SecretVault;
  ai: AiConfig;
  aiClientFactory: (cfg: {
    apiKey: string;
    model: string;
    baseUrl: string;
    appUrl?: string;
  }) => import('@xperiment/ai').ChatClient;
}
