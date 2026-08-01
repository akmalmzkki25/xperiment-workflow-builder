import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { hashToken } from '../src/authCrypto.js';
import { createPool, generateToken, runMigrations } from '../src/index.js';
import {
  consumeAuthToken,
  consumeOtherTokens,
  createAuthToken,
  EMAIL_VERIFY_TTL_MS,
  PASSWORD_RESET_TTL_MS,
} from '../src/repos/authTokens.js';
import { createUser, getUserByEmail, markEmailVerified, updatePassword } from '../src/repos/auth.js';

let pool: Pool;
let userId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE users CASCADE`);
  const u = await createUser(pool, { email: `t-${randomUUID()}@x.test`, passwordHash: 'h' });
  userId = u!.id;
});

/** Issues a token of `purpose` and returns its raw value. */
async function issue(purpose: 'email_verify' | 'password_reset'): Promise<string> {
  const prefix = purpose === 'email_verify' ? 'qv' : 'qr';
  const { token, hash } = generateToken(prefix);
  const ttl = purpose === 'email_verify' ? EMAIL_VERIFY_TTL_MS : PASSWORD_RESET_TTL_MS;
  await createAuthToken(pool, { userId, purpose, tokenHash: hash, expiresAt: new Date(Date.now() + ttl) });
  return token;
}

describe('auth token lifecycle', () => {
  test('a fresh token consumes once and returns its user', async () => {
    const token = await issue('password_reset');
    expect(await consumeAuthToken(pool, hashToken(token), 'password_reset')).toEqual({ userId });
  });

  test('a second use of the same token is refused', async () => {
    const token = await issue('password_reset');
    await consumeAuthToken(pool, hashToken(token), 'password_reset');
    expect(await consumeAuthToken(pool, hashToken(token), 'password_reset')).toBeNull();
  });

  test('an expired token is refused', async () => {
    const { token, hash } = generateToken('qr');
    await createAuthToken(pool, {
      userId,
      purpose: 'password_reset',
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(hashToken(token)).toBe(hash);
    expect(await consumeAuthToken(pool, hash, 'password_reset')).toBeNull();
  });

  test('a verification token cannot be consumed as a password reset', async () => {
    // The whole reason consume matches on purpose. A verify token lives 24 hours and is
    // mailed on every registration; without this it could be replayed to change a password.
    const token = await issue('email_verify');
    expect(await consumeAuthToken(pool, hashToken(token), 'password_reset')).toBeNull();
    // …and is still usable for what it was issued for.
    expect(await consumeAuthToken(pool, hashToken(token), 'email_verify')).toEqual({ userId });
  });

  test('an unknown token hash is refused', async () => {
    expect(await consumeAuthToken(pool, 'no-such-hash', 'password_reset')).toBeNull();
  });

  test('concurrent consumption elects exactly one winner', async () => {
    // Without the compare-and-set both callers would see an unconsumed row and both would
    // proceed to reset the password.
    await Promise.all([...Array(5)].map(() => pool.query('SELECT 1'))); // warm the pool
    for (let i = 0; i < 4; i += 1) {
      const token = await issue('password_reset');
      const hash = hashToken(token);
      const results = await Promise.all([
        consumeAuthToken(pool, hash, 'password_reset'),
        consumeAuthToken(pool, hash, 'password_reset'),
        consumeAuthToken(pool, hash, 'password_reset'),
      ]);
      expect(results.filter((r) => r !== null), `round ${i}`).toHaveLength(1);
    }
  });

  test('consumeOtherTokens burns the rest of that purpose and leaves the other alone', async () => {
    await issue('password_reset');
    await issue('password_reset');
    const verify = await issue('email_verify');
    expect(await consumeOtherTokens(pool, userId, 'password_reset')).toBe(2);
    // The verification token is untouched.
    expect(await consumeAuthToken(pool, hashToken(verify), 'email_verify')).toEqual({ userId });
  });
});

describe('user mutations', () => {
  test('markEmailVerified stamps the column and is visible on read', async () => {
    const before = await pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [userId],
    );
    expect(before.rows[0]!.email_verified_at).toBeNull();
    await markEmailVerified(pool, userId);
    const after = await pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [userId],
    );
    expect(after.rows[0]!.email_verified_at).not.toBeNull();
  });

  test('updatePassword replaces the hash', async () => {
    const row = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
    await updatePassword(pool, userId, 'new-hash');
    const user = await getUserByEmail(pool, row.rows[0]!.email);
    expect(user!.passwordHash).toBe('new-hash');
  });
});
