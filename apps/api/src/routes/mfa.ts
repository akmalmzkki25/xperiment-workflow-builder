import {
  appendAuditEvent,
  claimTotpStep,
  confirmMfa,
  countLiveRecoveryCodes,
  generateToken,
  generateTotpSecret,
  getMfa,
  getUserById,
  hashToken,
  otpauthUri,
  replaceRecoveryCodes,
  upsertPendingMfa,
  verifyTotpCode,
  type MfaRow,
} from '@xperiment/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { auditActor, authOf } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const ISSUER = 'Xperiment';
const RECOVERY_CODE_COUNT = 10;
const codeSchema = z.object({ code: z.string().min(6).max(64) }).strict();

/** Ten short opaque codes. The raw values leave the process once, in the response body. */
function mintRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateToken('qm').token.slice(3, 17));
  return { codes, hashes: codes.map(hashToken) };
}

export function registerMfaRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
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

  app.post('/v1/auth/mfa/setup', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no second factor');
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
    const parsed = codeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid code');
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
}
