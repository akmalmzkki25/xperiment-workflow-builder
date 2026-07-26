import { randomBytes } from 'node:crypto';
import {
  decryptSecret,
  deleteTriggersNotIn,
  encryptSecret,
  getVersion,
  getWorkflow,
  listTriggers,
  recentTestTriggerPayloads,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
  type TriggerRow,
} from '@xperiment/db';
import { nextFireAt } from '@xperiment/engine-core';
import { workflowIrSchema, type IRNode } from '@xperiment/ir';
import type { FastifyInstance } from 'fastify';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const DEFAULT_TZ = 'Asia/Jakarta';

function triggerView(t: TriggerRow, gatewayUrl: string, key: Buffer) {
  const base = { nodeId: t.nodeId, type: t.type, active: t.active };
  if (t.type === 'webhook') {
    return {
      ...base,
      url: `${gatewayUrl}/t/${t.routeKey}`,
      testUrl: `${gatewayUrl}/t/test/${t.routeKey}`,
      authMode: t.authMode,
      secret: t.secretEncrypted ? decryptSecret(t.secretEncrypted, key) : null,
    };
  }
  return { ...base, cron: t.cron, timezone: t.timezone, nextFireAt: t.nextFireAt };
}

export function registerTriggerRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workflows/:id/activate', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:activate')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    if (!wf.activeVersionId) return sendProblem(reply, 409, 'No published version', 'Publish before activating');
    const version = await getVersion(deps.pool, wf.activeVersionId);
    if (!version) return sendProblem(reply, 409, 'Active version missing');
    const ir = workflowIrSchema.parse(version.definition);

    const triggerNodes = ir.nodes.filter(
      (n: IRNode) => n.type === 'webhook.trigger' || n.type === 'schedule.trigger',
    );
    for (const node of triggerNodes) {
      if (node.type === 'webhook.trigger') {
        const p = node.parameters as { authMode: string; idempotencyKeyPath?: string };
        await upsertTrigger(deps.pool, {
          workflowId: id,
          nodeId: node.id,
          type: 'webhook',
          authMode: p.authMode,
          ...(p.idempotencyKeyPath ? { idempotencyKeyPath: p.idempotencyKeyPath } : {}),
          secretEncrypted:
            p.authMode === 'none'
              ? null
              : encryptSecret(randomBytes(24).toString('base64url'), deps.triggerKey),
        });
      } else {
        const p = node.parameters as { cron: string; timezone?: string };
        const tz = p.timezone ?? DEFAULT_TZ;
        await upsertTrigger(deps.pool, {
          workflowId: id,
          nodeId: node.id,
          type: 'schedule',
          cron: p.cron,
          timezone: tz,
          nextFireAt: nextFireAt(p.cron, tz, new Date()),
        });
      }
    }
    await deleteTriggersNotIn(deps.pool, id, ir.nodes.map((n) => n.id));
    await setTriggersActive(deps.pool, id, true);
    await setWorkflowActive(deps.pool, id, true);
    const fresh = await listTriggers(deps.pool, id);
    return { active: true, triggers: fresh.map((t) => triggerView(t, deps.gatewayUrl, deps.triggerKey)) };
  });

  app.post('/v1/workflows/:id/deactivate', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:activate')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    await setTriggersActive(deps.pool, id, false);
    await setWorkflowActive(deps.pool, id, false);
    return { active: false };
  });

  app.get('/v1/workflows/:id/triggers', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:read')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const rows = await listTriggers(deps.pool, id);
    return { triggers: rows.map((t) => triggerView(t, deps.gatewayUrl, deps.triggerKey)) };
  });

  app.get('/v1/workflows/:id/triggers/:nodeId/samples', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:read')) return;
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    if (!(await getWorkflow(deps.pool, id, ctx.workspaceId))) return sendProblem(reply, 404, 'Workflow not found');
    const rows = await listTriggers(deps.pool, id);
    if (!rows.some((t) => t.nodeId === nodeId)) return sendProblem(reply, 404, 'Trigger not found');
    return { samples: await recentTestTriggerPayloads(deps.pool, id, 5) };
  });
}
