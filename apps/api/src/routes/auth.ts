import {
  appendAuthEvent,
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
import { authOf } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(8) }).strict();

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
    });
    const { token, hash } = generateToken('qs');
    await createSession(deps.pool, { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    await appendAuthEvent(deps.pool, { userId: user.id, email: user.email, eventType: 'register', ip: req.ip });
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
      await appendAuthEvent(deps.pool, { email: parsed.data.email, eventType: 'login_failed', ip: req.ip });
      return sendProblem(reply, 401, 'Invalid credentials');
    }
    limiter.reset(limiterKey);
    const { token, hash } = generateToken('qs');
    await createSession(deps.pool, { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    await appendAuthEvent(deps.pool, { userId: user.id, email: user.email, eventType: 'login_succeeded', ip: req.ip });
    return { token };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const header = req.headers['authorization'];
    const token = typeof header === 'string' ? header.slice('Bearer '.length) : '';
    await revokeSession(deps.pool, hashToken(token));
    const ctx = authOf(req);
    await appendAuthEvent(deps.pool, { userId: ctx.userId ?? undefined, eventType: 'logout', ip: req.ip });
    return reply.status(204).send();
  });

  app.post('/v1/auth/logout-all', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys cannot revoke sessions');
    await revokeAllSessions(deps.pool, ctx.userId);
    await appendAuthEvent(deps.pool, { userId: ctx.userId, eventType: 'logout_all', ip: req.ip });
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
