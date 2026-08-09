import { randomBytes } from 'node:crypto';
import {
  appendAuditEvent,
  deleteTriggersNotIn,
  getVersion,
  getWorkflow,
  listTriggers,
  recentTestTriggerPayloads,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
  type SecretVault,
  type TriggerRow,
} from '@xperiment/db';
import { nextFireAt } from '@xperiment/engine-core';
import { workflowIrSchema, type IRNode } from '@xperiment/ir';
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../auth/permissions.js';
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
import { quotaBlocks } from './plan.js';
import { redactSecrets } from './redact.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const DEFAULT_TZ = 'Asia/Jakarta';

/**
 * A trigger's callable coordinates — route URL and signing secret — are authoring
 * data, not read data: whoever holds them can make the gateway start a production
 * run (it authenticates on the secret alone, or on nothing when authMode is 'none').
 * Handing them to a role without `workflow:activate` would turn `workflow:read`
 * into a transitive `execution:run`, so a reader sees only that a trigger exists.
 */
async function triggerView(
  t: TriggerRow,
  gatewayUrl: string,
  vault: SecretVault,
  includeCredentials: boolean,
): Promise<Record<string, unknown>> {
  const base = { nodeId: t.nodeId, type: t.type, active: t.active };
  if (t.type === 'webhook') {
    return {
      ...base,
      authMode: t.authMode,
      ...(includeCredentials
        ? {
            url: `${gatewayUrl}/t/${t.routeKey}`,
            testUrl: `${gatewayUrl}/t/test/${t.routeKey}`,
            secret: t.secretEncrypted
              ? await vault.decrypt(t.workspaceId, { blob: t.secretEncrypted, encVersion: t.secretEncVersion })
              : null,
          }
        : {}),
    };
  }
  return { ...base, cron: t.cron, timezone: t.timezone, nextFireAt: t.nextFireAt };
}

/**
 * Handing out a plaintext signing secret transfers a capability — whoever holds it can
 * make the gateway start a production run — so every response that carries one is
 * audited, per trigger. Both the activate response and the trigger listing do; auditing
 * only the listing would leave activate as an unlogged way to read the same secret.
 *
 * Emitted on the pool: nothing is mutated by a reveal.
 */
async function auditReveal(
  deps: ResolvedServerDeps,
  req: Parameters<typeof auditActor>[0],
  workspaceId: string,
  triggers: TriggerRow[],
): Promise<void> {
  for (const t of triggers) {
    if (t.type !== 'webhook' || !t.secretEncrypted) continue;
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      workspaceId,
      action: 'trigger_secret.reveal',
      targetType: 'trigger',
      targetId: t.nodeId,
      metadata: { workflowId: t.workflowId, authMode: t.authMode ?? 'none' },
    });
  }
}

export function registerTriggerRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workflows/:id/activate', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:activate')) return;
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'activeWorkflows')) return;
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
        // Hoisted out of the object literal because sealing is now async.
        const sealed =
          p.authMode === 'none'
            ? null
            : await deps.triggerVault.encrypt(ctx.workspaceId, randomBytes(24).toString('base64url'));
        await upsertTrigger(deps.pool, {
          workflowId: id,
          nodeId: node.id,
          type: 'webhook',
          authMode: p.authMode,
          ...(p.idempotencyKeyPath ? { idempotencyKeyPath: p.idempotencyKeyPath } : {}),
          secretEncrypted: sealed?.blob ?? null,
          ...(sealed ? { secretEncVersion: sealed.encVersion } : {}),
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
    const triggers = await Promise.all(fresh.map((t) => triggerView(t, deps.gatewayUrl, deps.triggerVault, true)));
    await auditReveal(deps, req, ctx.workspaceId, fresh);
    return { active: true, triggers };
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
    const withCredentials = hasPermission(ctx.role, 'workflow:activate');
    const triggers = await Promise.all(
      rows.map((t) => triggerView(t, deps.gatewayUrl, deps.triggerVault, withCredentials)),
    );
    if (withCredentials) await auditReveal(deps, req, ctx.workspaceId, rows);
    return { triggers };
  });

  app.get('/v1/workflows/:id/triggers/:nodeId/samples', async (req, reply) => {
    const ctx = authOf(req);
    // Same gate as the node payloads on the run timeline, and for the same reason: a
    // sample IS a node payload — it becomes trigger.body on every run. Whoever may
    // start a run may see the data that ran; a viewer may not.
    if (!requirePermission(reply, ctx, 'execution:run')) return;
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    if (!(await getWorkflow(deps.pool, id, ctx.workspaceId))) return sendProblem(reply, 404, 'Workflow not found');
    const rows = await listTriggers(deps.pool, id);
    if (!rows.some((t) => t.nodeId === nodeId)) return sendProblem(reply, 404, 'Trigger not found');
    const samples = await recentTestTriggerPayloads(deps.pool, id, nodeId, 5);
    // A webhook body is not author-typed text — it is whatever a provider sent, and
    // providers put bearer tokens in headers the gateway does not strip and verify
    // tokens in query strings. Redaction here is key-name based and therefore partial;
    // it does not clean what is already at rest, only what is shown.
    return { samples: samples.map(redactSecrets) };
  });
}
