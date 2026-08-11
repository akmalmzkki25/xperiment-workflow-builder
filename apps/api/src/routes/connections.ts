import { CONNECTION_PAYLOAD_SCHEMAS, type ConnectorKey } from '@xperiment/connectors';
import {
  appendAuditEvent,
  countPublishedRefs,
  createConnection,
  deleteConnection,
  getConnectionWithPayload,
  listConnections,
  replaceConnectionPayload,
  withTx,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const createSchema = z
  .object({
    connectorKey: z.string().min(1),
    name: z.string().min(1).max(200),
    payload: z.unknown(),
  })
  .strict();

/**
 * No `connectorKey`. It is read from the stored row, so a caller cannot repoint an
 * existing connection at a different connector while published nodes still name it.
 */
const rotateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    payload: z.unknown(),
  })
  .strict();

export function registerConnectionRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/connections', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'connection:write')) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const schema = CONNECTION_PAYLOAD_SCHEMAS[parsed.data.connectorKey as ConnectorKey];
    if (!schema) return sendProblem(reply, 400, 'Unknown connector key');
    const payload = schema.safeParse(parsed.data.payload);
    if (!payload.success) return sendProblem(reply, 400, 'Invalid connection payload', payload.error.message);

    const sealed = await deps.credentialsVault.encrypt(ctx.workspaceId, JSON.stringify(payload.data));
    // One transaction: the audit row must not survive a failed insert, and must not be
    // lost when the insert commits.
    const row = await withTx(deps.pool, async (client) => {
      const created = await createConnection(client, {
        workspaceId: ctx.workspaceId,
        connectorKey: parsed.data.connectorKey,
        name: parsed.data.name,
        encryptedPayload: sealed.blob,
        encVersion: sealed.encVersion,
      });
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'credential.create',
        targetType: 'connection',
        targetId: created.id,
        // Named scalars only — never the payload.
        metadata: { connectorKey: created.connectorKey, name: created.name },
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.get('/v1/connections', async (req, reply) => {
    // SEC-004: credential metadata is shared by role — viewers/operators/billing cannot list.
    if (!requirePermission(reply, authOf(req), 'connection:read')) return;
    return { items: await listConnections(deps.pool, authOf(req).workspaceId) };
  });

  app.put('/v1/connections/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'connection:write')) return;
    const { id } = req.params as { id: string };
    const parsed = rotateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);

    // Read first so the connector key comes from the row, never from the caller. Letting
    // it change would leave published nodes pointing at a connection whose payload no
    // longer matches the connector they call.
    const existing = await getConnectionWithPayload(deps.pool, id, ctx.workspaceId);
    if (!existing) return sendProblem(reply, 404, 'Connection not found');

    const schema = CONNECTION_PAYLOAD_SCHEMAS[existing.connectorKey as ConnectorKey];
    if (!schema) return sendProblem(reply, 400, 'Unknown connector key');
    // Whole replacement, validated in full. The stored payload is write-only and never
    // returned, so a form cannot prefill it — a merge would let someone submit only the
    // token they came to rotate and keep stale values for everything else, and the
    // mismatch would surface as a failed production run rather than a failed save.
    const payload = schema.safeParse(parsed.data.payload);
    if (!payload.success) return sendProblem(reply, 400, 'Invalid connection payload', payload.error.message);

    const sealed = await deps.credentialsVault.encrypt(ctx.workspaceId, JSON.stringify(payload.data));
    const row = await withTx(deps.pool, async (client) => {
      const updated = await replaceConnectionPayload(client, {
        id,
        workspaceId: ctx.workspaceId,
        encryptedPayload: sealed.blob,
        encVersion: sealed.encVersion,
        name: parsed.data.name,
      });
      if (!updated) return null;
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'credential.rotate',
        targetType: 'connection',
        targetId: id,
        // Named scalars only — never the payload, old or new.
        metadata: { connectorKey: updated.connectorKey, name: updated.name },
      });
      return updated;
    });
    if (!row) return sendProblem(reply, 404, 'Connection not found');
    return row;
  });

  app.delete('/v1/connections/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'connection:write')) return;
    const { id } = req.params as { id: string };
    const refs = await countPublishedRefs(deps.pool, id);
    if (refs > 0) {
      return sendProblem(reply, 409, 'Connection in use', `Referenced by ${refs} published workflow version(s)`);
    }
    const deleted = await withTx(deps.pool, async (client) => {
      const ok = await deleteConnection(client, id, ctx.workspaceId);
      if (!ok) return false;
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'credential.delete',
        targetType: 'connection',
        targetId: id,
      });
      return true;
    });
    if (!deleted) return sendProblem(reply, 404, 'Connection not found');
    return reply.status(204).send();
  });

  app.post('/v1/connections/:id/test', async (req, reply) => {
    // Testing dials a third party with the stored credential — a write-shaped action.
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'connection:write')) return;
    const { id } = req.params as { id: string };
    const row = await getConnectionWithPayload(deps.pool, id, ctx.workspaceId);
    if (!row) return sendProblem(reply, 404, 'Connection not found');
    const def = deps.registry
      .list()
      .find((d) => d.requiresConnection === row.connectorKey && d.testConnection !== undefined);
    if (!def?.testConnection) return sendProblem(reply, 400, 'Connector does not support test');
    let outcome: 'success' | 'failure' = 'success';
    try {
      const payload: unknown = JSON.parse(
        await deps.credentialsVault.decrypt(ctx.workspaceId, {
          blob: row.encryptedPayload,
          encVersion: row.encVersion,
        }),
      );
      await def.testConnection(payload, AbortSignal.timeout(10000));
    } catch {
      outcome = 'failure';
    }
    // A human decrypting a credential on demand is an auditable read, whether or not the
    // third party accepted it. Emitted on the pool: nothing was mutated.
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      workspaceId: ctx.workspaceId,
      action: 'credential.test',
      targetType: 'connection',
      targetId: id,
      outcome,
      metadata: { connectorKey: row.connectorKey },
    });
    // Never surface provider/internal error text — it may embed credentials.
    return outcome === 'success' ? { ok: true } : { ok: false, error: 'connection test failed' };
  });
}
