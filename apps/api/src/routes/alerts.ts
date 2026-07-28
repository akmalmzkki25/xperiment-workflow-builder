import { randomBytes } from 'node:crypto';
import {
  acknowledgeAlert,
  countUnacknowledgedAlerts,
  createAlertRule,
  deleteAlertRule,
  encryptSecret,
  getAlertRule,
  listAlertEvents,
  listAlertRules,
  updateAlertRule,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const failureParams = z.object({
  windowMinutes: z.number().int().min(1).max(1440),
  threshold: z.number().min(0).max(1),
  minSample: z.number().int().min(1).max(100000).default(1),
});
const usageParams = z.object({
  windowMinutes: z.number().int().min(1).max(1440),
  metric: z.enum(['execution', 'node', 'compute_ms', 'ai_tokens']),
  threshold: z.number().min(0),
});
const commonFields = { name: z.string().min(1).max(120), webhookUrl: z.string().url().optional(), cooldownMinutes: z.number().int().min(1).max(10080).optional() };
const createSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('failure_rate'), params: failureParams, ...commonFields }),
  z.object({ type: z.literal('usage_threshold'), params: usageParams, ...commonFields }),
]);
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  cooldownMinutes: z.number().int().min(1).max(10080).optional(),
  params: z.record(z.unknown()).optional(),
});

export function registerAlertRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/alerts', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'alert:write')) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid alert rule', parsed.error.message);
    const d = parsed.data;
    let secret: string | undefined;
    let webhookSecretEncrypted: Buffer | undefined;
    if (d.webhookUrl) {
      secret = randomBytes(24).toString('base64url');
      webhookSecretEncrypted = encryptSecret(secret, deps.triggerKey);
    }
    const rule = await createAlertRule(deps.pool, {
      workspaceId: ctx.workspaceId,
      name: d.name,
      type: d.type,
      params: d.params,
      ...(d.webhookUrl ? { webhookUrl: d.webhookUrl } : {}),
      ...(webhookSecretEncrypted ? { webhookSecretEncrypted } : {}),
      ...(d.cooldownMinutes ? { cooldownMinutes: d.cooldownMinutes } : {}),
    });
    return reply.status(201).send({ ...rule, ...(secret ? { secret } : {}) });
  });

  app.get('/v1/alerts', async (req, reply) => {
    if (!requirePermission(reply, authOf(req), 'alert:read')) return;
    return { items: await listAlertRules(deps.pool, authOf(req).workspaceId) };
  });

  app.put('/v1/alerts/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'alert:write')) return;
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid update', parsed.error.message);
    const existing = await getAlertRule(deps.pool, id, ctx.workspaceId);
    if (!existing) return sendProblem(reply, 404, 'Alert rule not found');
    const patch = { ...parsed.data };
    if (patch.params !== undefined) {
      // Re-validate replacement params against the rule's (immutable) type so a PUT
      // cannot bypass the create-time bounds (e.g. minSample>=1 that guards the sweep).
      const schema = existing.type === 'failure_rate' ? failureParams : usageParams;
      const pp = schema.safeParse(patch.params);
      if (!pp.success) return sendProblem(reply, 400, 'Invalid params', pp.error.message);
      patch.params = pp.data;
    }
    const updated = await updateAlertRule(deps.pool, id, ctx.workspaceId, patch);
    if (!updated) return sendProblem(reply, 404, 'Alert rule not found');
    return updated;
  });

  app.delete('/v1/alerts/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'alert:write')) return;
    const { id } = req.params as { id: string };
    const existing = await getAlertRule(deps.pool, id, ctx.workspaceId);
    if (!existing) return sendProblem(reply, 404, 'Alert rule not found');
    if (existing.managed) {
      return sendProblem(
        reply,
        409,
        'Managed rule',
        'The plan quota rule cannot be deleted. Disable it instead if you do not want the warnings.',
      );
    }
    await deleteAlertRule(deps.pool, id, ctx.workspaceId);
    return reply.status(204).send();
  });

  app.get('/v1/alerts/events', async (req, reply) => {
    if (!requirePermission(reply, authOf(req), 'alert:read')) return;
    const ws = authOf(req).workspaceId;
    const raw = Number((req.query as { limit?: string }).limit ?? 50);
    const limit = Number.isFinite(raw) ? raw : 50;
    return {
      items: await listAlertEvents(deps.pool, ws, limit),
      unacknowledged: await countUnacknowledgedAlerts(deps.pool, ws),
    };
  });

  app.post('/v1/alerts/events/:id/ack', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'alert:write')) return;
    const { id } = req.params as { id: string };
    const ok = await acknowledgeAlert(deps.pool, id, ctx.workspaceId);
    if (!ok) return sendProblem(reply, 404, 'Alert event not found or already acknowledged');
    return { acknowledged: true };
  });
}
