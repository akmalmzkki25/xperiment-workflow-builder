import {
  acceptInvite,
  appendAuditEvent,
  createApiKey,
  createInvite,
  createWorkspaceWithOwner,
  generateToken,
  hashToken,
  listApiKeys,
  listMembers,
  listMemberships,
  revokeApiKey,
  updateMemberRole,
  withTx,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
import { quotaBlocks } from './plan.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_ENUM = z.enum(['viewer', 'builder', 'operator', 'billing', 'admin', 'owner']);

export function registerWorkspaceRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workspaces', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only');
    const parsed = z.object({ name: z.string().min(1).max(200) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const ws = await createWorkspaceWithOwner(deps.pool, {
      name: parsed.data.name,
      userId: ctx.userId,
      actor: auditActor(req),
    });
    return reply.status(201).send(ws);
  });

  app.get('/v1/workspaces', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only');
    const memberships = await listMemberships(deps.pool, ctx.userId);
    return { items: memberships.map((m) => ({ id: m.workspaceId, name: m.name, role: m.role })) };
  });

  app.post('/v1/workspaces/invites', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'member:manage')) return;
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'members')) return;
    const parsed = z.object({ role: ROLE_ENUM }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    if (parsed.data.role === 'owner' && ctx.role !== 'owner') {
      return sendProblem(reply, 403, 'Forbidden', 'Only an owner can grant the owner role');
    }
    const { token, hash } = generateToken('qs');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await withTx(deps.pool, async (client) => {
      const invite = await createInvite(client, {
        workspaceId: ctx.workspaceId,
        tokenHash: hash,
        role: parsed.data.role,
        expiresAt,
      });
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'invite.create',
        targetType: 'invite',
        targetId: invite.id,
        // Never the token or its hash.
        metadata: { role: parsed.data.role, expiresAt: expiresAt.toISOString() },
      });
    });
    // Email delivery is deferred; the caller distributes the token.
    return reply.status(201).send({ token });
  });

  app.post('/v1/invites/accept', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only');
    const parsed = z.object({ token: z.string().min(1) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const result = await acceptInvite(deps.pool, hashToken(parsed.data.token), ctx.userId, auditActor(req));
    if (result.outcome === 'invalid') return sendProblem(reply, 404, 'Invite invalid or expired');
    if (result.outcome === 'quota_exceeded') {
      return sendProblem(
        reply,
        402,
        'Quota exceeded',
        `members: ${result.used} of ${result.limit} used. The workspace must upgrade before you can join.`,
      );
    }
    return { workspaceId: result.workspaceId };
  });

  app.post('/v1/api-keys', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'member:manage')) return;
    const parsed = z
      .object({ name: z.string().min(1).max(200), role: ROLE_ENUM.optional() })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    if (parsed.data.role === 'owner' && ctx.role !== 'owner') {
      return sendProblem(reply, 403, 'Forbidden', 'Only an owner can grant the owner role');
    }
    const { token, hash } = generateToken('qk');
    const row = await createApiKey(deps.pool, {
      workspaceId: ctx.workspaceId,
      name: parsed.data.name,
      keyHash: hash,
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
    });
    return reply.status(201).send({ id: row.id, name: row.name, role: row.role, key: token }); // shown once
  });

  app.get('/v1/workspaces/members', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'member:manage')) return;
    return { items: await listMembers(deps.pool, ctx.workspaceId) };
  });

  app.put('/v1/workspaces/members/:userId', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'member:manage')) return;
    const { userId } = req.params as { userId: string };
    if (!UUID_RE.test(userId)) return sendProblem(reply, 404, 'Member not found');
    const parsed = z.object({ role: ROLE_ENUM }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid role', parsed.error.message);
    if (parsed.data.role === 'owner' && ctx.role !== 'owner') {
      return sendProblem(reply, 403, 'Forbidden', 'Only an owner can grant the owner role');
    }
    const result = await updateMemberRole(deps.pool, {
      workspaceId: ctx.workspaceId,
      userId,
      role: parsed.data.role,
      actor: auditActor(req),
    });
    if (result.outcome === 'not_member') return sendProblem(reply, 404, 'Member not found');
    if (result.outcome === 'last_owner') {
      return sendProblem(reply, 409, 'Cannot demote the last owner', 'Promote another owner first');
    }
    return { userId, role: parsed.data.role };
  });

  app.get('/v1/api-keys', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'member:manage')) return;
    return { items: await listApiKeys(deps.pool, ctx.workspaceId) };
  });

  app.delete('/v1/api-keys/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'member:manage')) return;
    const { id } = req.params as { id: string };
    const revoked = await revokeApiKey(deps.pool, id, ctx.workspaceId);
    if (!revoked) return sendProblem(reply, 404, 'Api key not found');
    return reply.status(204).send();
  });
}
