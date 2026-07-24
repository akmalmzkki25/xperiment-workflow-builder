export type { ServerDeps } from '../server.js';

export interface ResolvedServerDeps {
  pool: import('pg').Pool;
  registry: import('@xperiment/connectors').ConnectorRegistry;
  gatewayUrl: string;
  triggerKey: Buffer;
  credentialsKey: Buffer;
}
