import {
  appendAuditEvent,
  consumeAuthToken,
  createAuthToken,
  createSession,
  createUser,
  createWorkspaceWithOwner,
  EMAIL_VERIFY_TTL_MS,
  generateToken,
  getUserById,
  getUserByEmail,
  hashPassword,
  hashToken,
  listMemberships,
  markEmailVerified,
  revokeAllSessions,
  revokeSession,
  verifyPassword,
} from '@xperiment/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LoginLimiter } from '../auth/rateLimit.js';
import { auditActor, authOf } from '../auth/plugin.js';
import { verifyEmailMessage } from '../mail/messages.js';
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
  const tokenSchema = z.object({ token: z.string().min(1).max(200) }).strict();

  /**
   * Issues a verification token, mails it, and records the request. Best-effort by design:
   * an SMTP outage must not block registration, so a send failure is logged and swallowed
   * while the token stays valid for a later resend.
   */
  async function sendVerification(user: { id: string; email: string }, req: FastifyRequest): Promise<void> {
    const { token, hash } = generateToken('qv');
    await createAuthToken(deps.pool, {
      userId: user.id,
      purpose: 'email_verify',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    });
    await appendAuditEvent(deps.pool, {
      ...requestFacts(req),
      actorKind: 'user',
      actorUserId: user.id,
      actorLabel: user.email,
      action: 'auth.email_verify_requested',
      targetType: 'user',
      targetId: user.id,
    });
    try {
      await deps.mailSender.send(verifyEmailMessage(user.email, deps.appUrl, token));
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'verification email could not be sent');
    }
  }

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
    await sendVerification(user, req);
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

  app.post('/v1/auth/verify-email', async (req, reply) => {
    const parsed = tokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid or expired token');
    const claimed = await consumeAuthToken(deps.pool, hashToken(parsed.data.token), 'email_verify');
    // One message for unknown, expired, consumed and wrong-purpose alike: telling them
    // apart would say which of a stolen batch is still live.
    if (!claimed) return sendProblem(reply, 400, 'Invalid or expired token');
    await markEmailVerified(deps.pool, claimed.userId);
    await appendAuditEvent(deps.pool, {
      ...requestFacts(req),
      actorKind: 'user',
      actorUserId: claimed.userId,
      action: 'auth.email_verified',
      targetType: 'user',
      targetId: claimed.userId,
    });
    return { verified: true };
  });

  app.post('/v1/auth/resend-verification', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no email to verify');
    // Keyed on userId, not email: the caller is already identified and sends no body.
    if (!limiter.check(`resend:${ctx.userId}:${req.ip}`)) {
      return sendProblem(reply, 429, 'Too many attempts', 'Try again in a minute');
    }
    const user = await getUserById(deps.pool, ctx.userId);
    if (!user) return sendProblem(reply, 400, 'Sessions only');
    if (user.emailVerifiedAt) return { verified: true };
    await sendVerification(user, req);
    return { verified: false };
  });

  app.get('/v1/auth/me', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no user profile');
    const [memberships, user] = await Promise.all([
      listMemberships(deps.pool, ctx.userId),
      getUserById(deps.pool, ctx.userId),
    ]);
    return {
      user: { id: ctx.userId },
      emailVerified: user?.emailVerifiedAt != null,
      currentWorkspaceId: ctx.workspaceId,
      workspaces: memberships.map((m) => ({ id: m.workspaceId, name: m.name, role: m.role })),
    };
  });
}
