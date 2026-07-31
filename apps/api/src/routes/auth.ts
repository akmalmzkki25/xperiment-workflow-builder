import {
  appendAuditEvent,
  createSession,
  createUser,
  createWorkspaceWithOwner,
  generateToken,
  getUserByEmail,
  hashPassword,
  hashToken,
  listMemberships,
  revokeAllSessions,
  revokeSession,
  verifyPassword,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LoginLimiter } from '../auth/rateLimit.js';
import { auditActor, authOf } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(8) }).strict();

/**
 * Request provenance for the two routes that sit outside the auth plugin. `/register`
 * and `/login` are in EXEMPT, so there is no authContext and auditActor cannot be used;
 * the actor fields are supplied explicitly at those call sites instead.
 */
function requestFacts(req: { id: string; ip: string; headers: Record<string, unknown> }): {
  requestId: string;
  ip: string;
  userAgent: string | null;
} {
  return {
    requestId: req.id,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  const limiter = new LoginLimiter();

  app.post('/v1/auth/register', async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const user = await createUser(deps.pool, {
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
    });
    if (!user) return sendProblem(reply, 409, 'Email already registered');
    const workspace = await createWorkspaceWithOwner(deps.pool, {
      name: `${parsed.data.email.split('@')[0]}'s workspace`,
      userId: user.id,
      // Outside the auth plugin, so there is no authContext for auditActor(req) to read.
      actor: { ...requestFacts(req), actorKind: 'user', actorUserId: user.id, actorLabel: user.email },
    });
    const { token, hash } = generateToken('qs');
    await createSession(deps.pool, { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    await appendAuditEvent(deps.pool, {
      ...requestFacts(req),
      actorKind: 'user',
      actorUserId: user.id,
      actorLabel: user.email,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
    });
    return reply.status(201).send({
      token,
      user: { id: user.id, email: user.email },
      workspace,
    });
  });

  app.post('/v1/auth/login', async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const limiterKey = `${parsed.data.email}:${req.ip}`;
    if (!limiter.check(limiterKey)) {
      return sendProblem(reply, 429, 'Too many attempts', 'Try again in a minute');
    }
    const user = await getUserByEmail(deps.pool, parsed.data.email);
    const ok = user !== null && (await verifyPassword(parsed.data.password, user.passwordHash));
    if (!ok || !user) {
      // No workspace and no user id: the email may not correspond to an account at all,
      // and a global row must never surface in a workspace's audit view.
      await appendAuditEvent(deps.pool, {
        ...requestFacts(req),
        actorKind: 'anonymous',
        actorLabel: parsed.data.email,
        action: 'auth.login_failed',
        outcome: 'failure',
      });
      return sendProblem(reply, 401, 'Invalid credentials');
    }
    limiter.reset(limiterKey);
    const { token, hash } = generateToken('qs');
    await createSession(deps.pool, { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    await appendAuditEvent(deps.pool, {
      ...requestFacts(req),
      actorKind: 'user',
      actorUserId: user.id,
      actorLabel: user.email,
      action: 'auth.login_succeeded',
      targetType: 'user',
      targetId: user.id,
    });
    return { token };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const header = req.headers['authorization'];
    const token = typeof header === 'string' ? header.slice('Bearer '.length) : '';
    await revokeSession(deps.pool, hashToken(token));
    const ctx = authOf(req);
    // Behind the auth plugin, so the actor is known and the event belongs to the
    // workspace the session was acting in.
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      workspaceId: ctx.workspaceId,
      action: 'auth.logout',
      targetType: 'user',
      targetId: ctx.userId,
    });
    return reply.status(204).send();
  });

  app.post('/v1/auth/logout-all', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys cannot revoke sessions');
    await revokeAllSessions(deps.pool, ctx.userId);
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      workspaceId: ctx.workspaceId,
      action: 'auth.logout_all',
      targetType: 'user',
      targetId: ctx.userId,
    });
    return reply.status(204).send();
  });

  app.get('/v1/auth/me', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no user profile');
    const memberships = await listMemberships(deps.pool, ctx.userId);
    return {
      user: { id: ctx.userId },
      currentWorkspaceId: ctx.workspaceId,
      workspaces: memberships.map((m) => ({ id: m.workspaceId, name: m.name, role: m.role })),
    };
  });
}
