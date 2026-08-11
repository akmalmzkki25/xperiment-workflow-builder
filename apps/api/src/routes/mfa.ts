import {
  appendAuditEvent,
  claimTotpStep,
  confirmMfa,
  consumeAuthToken,
  consumeRecoveryCode,
  countLiveRecoveryCodes,
  createSession,
  deleteMfa,
  generateToken,
  generateTotpSecret,
  getMfa,
  getUserById,
  hashToken,
  otpauthUri,
  peekAuthToken,
  replaceRecoveryCodes,
  upsertPendingMfa,
  verifyPassword,
  workspacesRequiringMfa,
  verifyTotpCode,
  type MfaRow,
} from '@xperiment/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { auditActor, authOf } from '../auth/plugin.js';
import { LoginLimiter } from '../auth/rateLimit.js';
import { sendProblem } from '../problem.js';
import { requestFacts } from './auth.js';
import type { ResolvedServerDeps } from './deps.js';

const ISSUER = 'Xperiment';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const RECOVERY_CODE_COUNT = 10;
const codeSchema = z.object({ code: z.string().min(6).max(64) }).strict();
const passwordSchema = z.object({ password: z.string().min(1).max(200) }).strict();
const confirmSchema = z.object({ code: z.string().min(6).max(64), password: z.string().min(1).max(200) }).strict();

/** Ten short opaque codes. The raw values leave the process once, in the response body. */
function mintRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateToken('qm').token.slice(3, 17));
  return { codes, hashes: codes.map(hashToken) };
}

export function registerMfaRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  // Per challenge: a typo costs the caller their five attempts on THAT challenge only.
  const verifyLimiter = new LoginLimiter(deps.limiterStore);
  // Per account, and this is the one that matters. Keying only on the challenge bounded
  // nothing: whoever holds the password can mint challenges without limit — login resets its
  // own limiter the moment the password verifies — and each fresh challenge would hand them
  // five more guesses at a six-digit code. Five attempts a minute per account is what makes
  // the second factor cost anything to guess.
  const accountLimiter = new LoginLimiter(deps.limiterStore);
  const passwordLimiter = new LoginLimiter(deps.limiterStore);

  /**
   * Unwraps the stored secret. A row wrapped by a different root key cannot be opened, so
   * say so plainly rather than letting every correct code look wrong.
   */
  async function openSecret(row: MfaRow, reply: FastifyReply): Promise<Buffer | null> {
    if (row.rootKeyId !== deps.keyProvider.keyId) {
      sendProblem(reply, 503, 'MFA temporarily unavailable', 'This account was enrolled under a different root key');
      return null;
    }
    return deps.keyProvider.unwrap(row.secretEnc);
  }

  /**
   * Proves possession of the second factor with either a TOTP code or a recovery code.
   * Returns which kind matched, or null. Both paths are single-use: the TOTP step is
   * claimed against the replay floor, the recovery code is consumed by compare-and-set.
   */
  async function proveCode(userId: string, code: string, reply: FastifyReply): Promise<'totp' | 'recovery' | null> {
    const row = await getMfa(deps.pool, userId);
    if (!row?.confirmedAt) return null;
    const secret = await openSecret(row, reply);
    if (!secret) return null;
    const step = verifyTotpCode({ secret, code, after: Number(row.lastUsedStep ?? 0) || null });
    if (step !== null && (await claimTotpStep(deps.pool, userId, step))) return 'totp';
    if (await consumeRecoveryCode(deps.pool, userId, hashToken(code))) return 'recovery';
    return null;
  }

  /**
   * Re-authenticates the caller by password. Enrolment must not be reachable from a bearer
   * token alone: a stolen session could otherwise attach a factor the real owner does not
   * hold, and because a password reset revokes sessions but leaves MFA standing, the owner
   * would reset, log in, and be challenged for a code only the attacker has. With no
   * owner-initiated reset, that is a permanent takeover.
   *
   * Rate-limited on the user id so this cannot become a password oracle.
   */
  async function reauthenticated(userId: string, password: string, ip: string, reply: FastifyReply): Promise<boolean> {
    if (!(await passwordLimiter.check(`reauth:${userId}:${ip}`))) {
      sendProblem(reply, 429, 'Too many attempts', 'Try again in a minute');
      return false;
    }
    const user = await getUserById(deps.pool, userId);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      sendProblem(reply, 401, 'Invalid password');
      return false;
    }
    await passwordLimiter.reset(`reauth:${userId}:${ip}`);
    return true;
  }

  app.post('/v1/auth/mfa/setup', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no second factor');
    const parsedBody = passwordSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) return sendProblem(reply, 400, 'Invalid password');
    if (!(await reauthenticated(ctx.userId, parsedBody.data.password, req.ip, reply))) return reply;
    const user = await getUserById(deps.pool, ctx.userId);
    if (!user) return sendProblem(reply, 400, 'Sessions only');
    const { secret, base32 } = generateTotpSecret();
    const stored = await upsertPendingMfa(deps.pool, {
      userId: ctx.userId,
      secretEnc: await deps.keyProvider.wrap(secret),
      rootKeyId: deps.keyProvider.keyId,
    });
    // A confirmed factor is never silently replaced: disable it first, deliberately.
    if (!stored) return sendProblem(reply, 409, 'Already enrolled', 'Disable the current factor first');
    return { secretBase32: base32, otpauthUri: otpauthUri({ issuer: ISSUER, account: user.email, base32 }) };
  });

  app.post('/v1/auth/mfa/confirm', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no second factor');
    const parsed = confirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid code');
    // Both steps re-authenticate: setup alone leaves a pending secret, but confirm is what
    // turns it into the factor that gates every future login.
    if (!(await reauthenticated(ctx.userId, parsed.data.password, req.ip, reply))) return reply;
    const row = await getMfa(deps.pool, ctx.userId);
    if (!row || row.confirmedAt) return sendProblem(reply, 400, 'Invalid code');
    const secret = await openSecret(row, reply);
    if (!secret) return reply;
    const step = verifyTotpCode({ secret, code: parsed.data.code, after: Number(row.lastUsedStep ?? 0) || null });
    if (step === null) return sendProblem(reply, 400, 'Invalid code');
    await claimTotpStep(deps.pool, ctx.userId, step);
    await confirmMfa(deps.pool, ctx.userId);
    const { codes, hashes } = mintRecoveryCodes();
    await replaceRecoveryCodes(deps.pool, ctx.userId, hashes);
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      action: 'auth.mfa_enabled',
      targetType: 'user',
      targetId: ctx.userId,
    });
    // The only time these leave the server. There is no endpoint that shows them again.
    return { recoveryCodes: codes, remaining: await countLiveRecoveryCodes(deps.pool, ctx.userId) };
  });

  app.post('/v1/auth/mfa/disable', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no second factor');
    const parsed = codeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid code');
    // A workspace that requires the second factor of its privileged members must not be
    // left with one who has switched it off — they would be locked out of everything but the
    // carve-out routes, and the workspace would be short an administrator until they enrol
    // again. Refuse before spending the code.
    const blocking = await workspacesRequiringMfa(deps.pool, ctx.userId);
    if (blocking.length > 0) {
      return sendProblem(
        reply,
        409,
        'Required by a workspace',
        `Two-factor is required of your role in ${blocking.length} workspace(s); leave or change the policy first`,
      );
    }
    const kind = await proveCode(ctx.userId, parsed.data.code, reply);
    if (reply.sent) return reply;
    if (!kind) return sendProblem(reply, 400, 'Invalid code');
    await deleteMfa(deps.pool, ctx.userId);
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      action: 'auth.mfa_disabled',
      targetType: 'user',
      targetId: ctx.userId,
      metadata: { proof: kind },
    });
    return { mfaEnabled: false };
  });

  app.post('/v1/auth/mfa/recovery-codes', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no second factor');
    const parsed = codeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid code');
    const kind = await proveCode(ctx.userId, parsed.data.code, reply);
    if (reply.sent) return reply;
    if (!kind) return sendProblem(reply, 400, 'Invalid code');
    const { codes, hashes } = mintRecoveryCodes();
    await replaceRecoveryCodes(deps.pool, ctx.userId, hashes);
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      action: 'auth.mfa_recovery_regenerated',
      targetType: 'user',
      targetId: ctx.userId,
    });
    return { recoveryCodes: codes, remaining: codes.length };
  });

  app.post('/v1/auth/mfa/verify', async (req, reply) => {
    const parsed = z
      .object({ challenge: z.string().min(1).max(200), code: z.string().min(6).max(64) })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid or expired token');
    const challengeHash = hashToken(parsed.data.challenge);
    if (!(await verifyLimiter.check(`mfa:${challengeHash}`))) {
      // Out of attempts: destroy the challenge rather than leave it sitting there for the
      // next minute's worth of guesses.
      await consumeAuthToken(deps.pool, challengeHash, 'mfa_challenge');
      return sendProblem(reply, 429, 'Too many attempts', 'Sign in again');
    }
    // Peek, not consume: a wrong code must not cost the user their challenge.
    const peeked = await peekAuthToken(deps.pool, challengeHash, 'mfa_challenge');
    if (!peeked) return sendProblem(reply, 400, 'Invalid or expired token');
    // The account cap, checked once the challenge has identified whose account this is.
    // Minting a new challenge does not reset it, which is what bounds the search space.
    if (!(await accountLimiter.check(`mfa-account:${peeked.userId}`))) {
      await consumeAuthToken(deps.pool, challengeHash, 'mfa_challenge');
      await appendAuditEvent(deps.pool, {
        ...requestFacts(req),
        actorKind: 'user',
        actorUserId: peeked.userId,
        action: 'auth.mfa_failed',
        targetType: 'user',
        targetId: peeked.userId,
        outcome: 'failure',
        metadata: { reason: 'too_many_attempts' },
      });
      return sendProblem(reply, 429, 'Too many attempts', 'Try again in a minute');
    }
    const kind = await proveCode(peeked.userId, parsed.data.code, reply);
    if (reply.sent) return reply;
    if (!kind) {
      await appendAuditEvent(deps.pool, {
        ...requestFacts(req),
        actorKind: 'user',
        actorUserId: peeked.userId,
        action: 'auth.mfa_failed',
        targetType: 'user',
        targetId: peeked.userId,
        outcome: 'failure',
      });
      return sendProblem(reply, 400, 'Invalid code');
    }
    // Only now is the challenge spent, and the CAS decides a race between two winners.
    const claimed = await consumeAuthToken(deps.pool, challengeHash, 'mfa_challenge');
    if (!claimed) return sendProblem(reply, 400, 'Invalid or expired token');
    await verifyLimiter.reset(`mfa:${challengeHash}`);
    // Only a completed second step clears the account's budget.
    await accountLimiter.reset(`mfa-account:${peeked.userId}`);
    const { token, hash } = generateToken('qs');
    await createSession(deps.pool, {
      userId: peeked.userId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    const facts = { ...requestFacts(req), actorKind: 'user' as const, actorUserId: peeked.userId };
    await appendAuditEvent(deps.pool, {
      ...facts,
      action: kind === 'recovery' ? 'auth.mfa_recovery_used' : 'auth.mfa_verified',
      targetType: 'user',
      targetId: peeked.userId,
    });
    await appendAuditEvent(deps.pool, {
      ...facts,
      action: 'auth.login_succeeded',
      targetType: 'user',
      targetId: peeked.userId,
    });
    return { token, recoveryCodesRemaining: await countLiveRecoveryCodes(deps.pool, peeked.userId) };
  });
}
