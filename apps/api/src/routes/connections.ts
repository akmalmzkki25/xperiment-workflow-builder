import { CONNECTION_PAYLOAD_SCHEMAS, type ConnectorKey } from '@xperiment/connectors';
import {
  countPublishedRefs,
  createConnection,
  decryptSecret,
  deleteConnection,
  encryptSecret,
  getConnectionWithPayload,
  listConnections,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const createSchema = z
  .object({
    connectorKey: z.string().min(1),
    name: z.string().min(1).max(200),
    payload: z.unknown(),
  })
  .strict();

export function registerConnectionRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/connections', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const schema = CONNECTION_PAYLOAD_SCHEMAS[parsed.data.connectorKey as ConnectorKey];
    if (!schema) return sendProblem(reply, 400, 'Unknown connector key');
    const payload = schema.safeParse(parsed.data.payload);
    if (!payload.success) return sendProblem(reply, 400, 'Invalid connection payload', payload.error.message);
    const row = await createConnection(deps.pool, {
      connectorKey: parsed.data.connectorKey,
      name: parsed.data.name,
      encryptedPayload: encryptSecret(JSON.stringify(payload.data), deps.credentialsKey),
    });
    return reply.status(201).send(row);
  });

  app.get('/v1/connections', async () => {
    return { items: await listConnections(deps.pool) };
  });

  app.delete('/v1/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const refs = await countPublishedRefs(deps.pool, id);
    if (refs > 0) {
      return sendProblem(reply, 409, 'Connection in use', `Referenced by ${refs} published workflow version(s)`);
    }
    const deleted = await deleteConnection(deps.pool, id);
    if (!deleted) return sendProblem(reply, 404, 'Connection not found');
    return reply.status(204).send();
  });

  app.post('/v1/connections/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getConnectionWithPayload(deps.pool, id);
    if (!row) return sendProblem(reply, 404, 'Connection not found');
    const def = deps.registry
      .list()
      .find((d) => d.requiresConnection === row.connectorKey && d.testConnection !== undefined);
    if (!def?.testConnection) return sendProblem(reply, 400, 'Connector does not support test');
    try {
      const payload: unknown = JSON.parse(decryptSecret(row.encryptedPayload, deps.credentialsKey));
      await def.testConnection(payload, AbortSignal.timeout(10000));
      return { ok: true };
    } catch {
      // Never surface provider/internal error text — it may embed credentials.
      return { ok: false, error: 'connection test failed' };
    }
  });
}
