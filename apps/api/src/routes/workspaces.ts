import {
  acceptInvite,
  createApiKey,
  createInvite,
  createWorkspaceWithOwner,
  generateToken,
  hashToken,
  listApiKeys,
  listMemberships,
  revokeApiKey,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, roleGate } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export function registerWorkspaceRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workspaces', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only');
    const parsed = z.object({ name: z.string().min(1).max(200) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const ws = await createWorkspaceWithOwner(deps.pool, { name: parsed.data.name, userId: ctx.userId });
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
    if (!roleGate(reply, ctx, 'admin')) return;
    const parsed = z
      .object({ role: z.enum(['viewer', 'builder', 'admin']) })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const { token, hash } = generateToken('qs');
    await createInvite(deps.pool, {
      workspaceId: ctx.workspaceId,
      tokenHash: hash,
      role: parsed.data.role,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    // Email delivery is deferred; the caller distributes the token.
    return reply.status(201).send({ token });
  });

  app.post('/v1/invites/accept', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only');
    const parsed = z.object({ token: z.string().min(1) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const workspaceId = await acceptInvite(deps.pool, hashToken(parsed.data.token), ctx.userId);
    if (!workspaceId) return sendProblem(reply, 404, 'Invite invalid or expired');
    return { workspaceId };
  });

  app.post('/v1/api-keys', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'admin')) return;
    const parsed = z.object({ name: z.string().min(1).max(200) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const { token, hash } = generateToken('qk');
    const row = await createApiKey(deps.pool, { workspaceId: ctx.workspaceId, name: parsed.data.name, keyHash: hash });
    return reply.status(201).send({ id: row.id, name: row.name, key: token }); // shown once
  });

  app.get('/v1/api-keys', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'admin')) return;
    return { items: await listApiKeys(deps.pool, ctx.workspaceId) };
  });

  app.delete('/v1/api-keys/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'admin')) return;
    const { id } = req.params as { id: string };
    const revoked = await revokeApiKey(deps.pool, id, ctx.workspaceId);
    if (!revoked) return sendProblem(reply, 404, 'Api key not found');
    return reply.status(204).send();
  });
}
