import { type Db } from '../pool.js';

export type AuthTokenPurpose = 'email_verify' | 'password_reset';

export const EMAIL_VERIFY_TTL_MS = 86_400_000; // 24 hours
export const PASSWORD_RESET_TTL_MS = 3_600_000; // 1 hour

export async function createAuthToken(
  db: Db,
  args: { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: Date },
): Promise<{ id: string }> {
  const r = await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [args.userId, args.purpose, args.tokenHash, args.expiresAt],
  );
  return { id: (r.rows[0] as { id: string }).id };
}

/**
 * Compare-and-set: the same statement checks liveness and claims the token, so two
 * concurrent callers cannot both proceed. Matching `purpose` is not decoration — a
 * verification token lives 24 hours and is mailed on every registration, so without it one
 * could be replayed against the reset endpoint to change a password.
 *
 * Returns null for unknown, expired, already-consumed and wrong-purpose alike; the caller
 * must not distinguish them, or the endpoint becomes an oracle telling an attacker which of
 * a stolen batch is still live.
 */
export async function consumeAuthToken(
  db: Db,
  tokenHash: string,
  purpose: AuthTokenPurpose,
): Promise<{ userId: string } | null> {
  const r = await db.query(
    `UPDATE auth_tokens SET consumed_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [tokenHash, purpose],
  );
  if (!r.rowCount) return null;
  return { userId: (r.rows[0] as { user_id: string }).user_id };
}

/** Burns a user's other live tokens of one purpose. Returns how many were burnt. */
export async function consumeOtherTokens(db: Db, userId: string, purpose: AuthTokenPurpose): Promise<number> {
  const r = await db.query(
    `UPDATE auth_tokens SET consumed_at = now()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()`,
    [userId, purpose],
  );
  return r.rowCount ?? 0;
}
