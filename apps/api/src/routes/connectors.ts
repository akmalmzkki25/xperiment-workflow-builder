import { connectorCatalog } from '@xperiment/connectors';
import type { FastifyInstance } from 'fastify';
import type { ResolvedServerDeps } from './deps.js';

export function registerConnectorRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  // Cached once: the registry is fixed for the server's lifetime.
  const items = connectorCatalog(deps.registry);
  app.get('/v1/connectors', async () => ({ items }));
}
