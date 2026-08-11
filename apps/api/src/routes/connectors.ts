import { connectionSchemas, connectorCatalog } from '@xperiment/connectors';
import type { FastifyInstance } from 'fastify';
import type { ResolvedServerDeps } from './deps.js';

export function registerConnectorRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  // Cached once: the registry is fixed for the server's lifetime.
  const items = connectorCatalog(deps.registry);
  // Shipped alongside the node catalog rather than on its own route: the editor already
  // fetches this, and a second endpoint would be a second round trip for data that never
  // changes. Keyed by connector (`telegram`), not node type (`telegram.sendMessage`).
  const connections = connectionSchemas();
  app.get('/v1/connectors', async () => ({ items, connections }));
}
