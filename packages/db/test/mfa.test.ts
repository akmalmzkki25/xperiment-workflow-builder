import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, runMigrations } from '../src/index.js';
import { hashToken } from '../src/authCrypto.js';
import { createUser } from '../src/repos/auth.js';
import { createAuthToken, consumeAuthToken, peekAuthToken } from '../src/repos/authTokens.js';
import {
  claimTotpStep,
  confirmMfa,
  consumeRecoveryCode,
  countLiveRecoveryCodes,
  deleteMfa,
  getMfa,
  hasConfirmedMfa,
  replaceRecoveryCodes,
  upsertPendingMfa,
} from '../src/repos/mfa.js';

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const u = await createUser(pool, { email: `mfa-${randomUUID()}@xperiment.test`, passwordHash: 'x:y' });
  return u!.id;
}

async function enrol(userId: string): Promise<void> {
  await upsertPendingMfa(pool, { userId, secretEnc: randomBytes(48), rootKeyId: 'local:test' });
  await confirmMfa(pool, userId);
}

describe('user_mfa', () => {
  test('stores a pending secret that is not yet a second factor', async () => {
    const userId = await newUser();
    expect(await upsertPendingMfa(pool, { userId, secretEnc: randomBytes(48), rootKeyId: 'local:test' })).toBe(true);
    const row = await getMfa(pool, userId);
    expect(row?.confirmedAt).toBeNull();
    expect(await hasConfirmedMfa(pool, userId)).toBe(false);
  });

  test('confirming makes it a second factor, and confirming twice is not an error', async () => {
    const userId = await newUser();
    await upsertPendingMfa(pool, { userId, secretEnc: randomBytes(48), rootKeyId: 'local:test' });
    expect(await confirmMfa(pool, userId)).toBe(true);
    expect(await hasConfirmedMfa(pool, userId)).toBe(true);
    expect(await confirmMfa(pool, userId)).toBe(false);
  });

  test('a pending row may be replaced but a confirmed one may not', async () => {
    const userId = await newUser();
    await upsertPendingMfa(pool, { userId, secretEnc: Buffer.from('first'), rootKeyId: 'local:test' });
    expect(await upsertPendingMfa(pool, { userId, secretEnc: Buffer.from('second'), rootKeyId: 'local:test' })).toBe(
      true,
    );
    expect((await getMfa(pool, userId))?.secretEnc.toString()).toBe('second');
    await confirmMfa(pool, userId);
    // Re-running setup must not silently swap the secret out from under a working factor.
    expect(await upsertPendingMfa(pool, { userId, secretEnc: Buffer.from('third'), rootKeyId: 'local:test' })).toBe(
      false,
    );
    expect((await getMfa(pool, userId))?.secretEnc.toString()).toBe('second');
  });

  test('deleting removes the factor and its recovery codes', async () => {
    const userId = await newUser();
    await enrol(userId);
    await replaceRecoveryCodes(pool, userId, [hashToken('a'), hashToken('b')]);
    await deleteMfa(pool, userId);
    expect(await getMfa(pool, userId)).toBeNull();
    expect(await countLiveRecoveryCodes(pool, userId)).toBe(0);
  });
});

describe('claimTotpStep', () => {
  test('a step can be claimed once and never again', async () => {
    const userId = await newUser();
    await enrol(userId);
    expect(await claimTotpStep(pool, userId, 100)).toBe(true);
    expect(await claimTotpStep(pool, userId, 100)).toBe(false);
    expect(await claimTotpStep(pool, userId, 99)).toBe(false);
    expect(await claimTotpStep(pool, userId, 101)).toBe(true);
  });

  test('concurrent claims of one step produce exactly one winner', async () => {
    const userId = await newUser();
    await enrol(userId);
    const results = await Promise.all([
      claimTotpStep(pool, userId, 500),
      claimTotpStep(pool, userId, 500),
      claimTotpStep(pool, userId, 500),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('recovery codes', () => {
  test('are single use and a spent one stays dead', async () => {
    const userId = await newUser();
    await enrol(userId);
    await replaceRecoveryCodes(pool, userId, ['x', 'y', 'z'].map(hashToken));
    expect(await countLiveRecoveryCodes(pool, userId)).toBe(3);
    expect(await consumeRecoveryCode(pool, userId, hashToken('y'))).toBe(true);
    expect(await consumeRecoveryCode(pool, userId, hashToken('y'))).toBe(false);
    expect(await countLiveRecoveryCodes(pool, userId)).toBe(2);
  });

  test('another user cannot spend this user code', async () => {
    const mine = await newUser();
    const theirs = await newUser();
    await enrol(mine);
    await enrol(theirs);
    await replaceRecoveryCodes(pool, mine, [hashToken('shared-secret-code')]);
    expect(await consumeRecoveryCode(pool, theirs, hashToken('shared-secret-code'))).toBe(false);
    expect(await countLiveRecoveryCodes(pool, mine)).toBe(1);
  });

  test('regenerating invalidates the whole previous set', async () => {
    const userId = await newUser();
    await enrol(userId);
    await replaceRecoveryCodes(pool, userId, [hashToken('old-1'), hashToken('old-2')]);
    await replaceRecoveryCodes(pool, userId, [hashToken('new-1')]);
    expect(await consumeRecoveryCode(pool, userId, hashToken('old-1'))).toBe(false);
    expect(await countLiveRecoveryCodes(pool, userId)).toBe(1);
  });
});

describe('mfa_challenge tokens', () => {
  test('the purpose is accepted by the CHECK constraint', async () => {
    const userId = await newUser();
    const hash = hashToken(`qm_${randomUUID()}`);
    await createAuthToken(pool, {
      userId,
      purpose: 'mfa_challenge',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 300_000),
    });
    expect(await peekAuthToken(pool, hash, 'mfa_challenge')).toEqual({ userId });
  });

  test('peek does not consume, and the purpose still has to match', async () => {
    const userId = await newUser();
    const hash = hashToken(`qm_${randomUUID()}`);
    await createAuthToken(pool, {
      userId,
      purpose: 'mfa_challenge',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 300_000),
    });
    expect(await peekAuthToken(pool, hash, 'mfa_challenge')).toEqual({ userId });
    expect(await peekAuthToken(pool, hash, 'password_reset')).toBeNull();
    // Still live after two peeks — a wrong code must not burn the challenge.
    expect(await consumeAuthToken(pool, hash, 'mfa_challenge')).toEqual({ userId });
    expect(await peekAuthToken(pool, hash, 'mfa_challenge')).toBeNull();
  });

  test('an expired challenge does not peek', async () => {
    const userId = await newUser();
    const hash = hashToken(`qm_${randomUUID()}`);
    await createAuthToken(pool, {
      userId,
      purpose: 'mfa_challenge',
      tokenHash: hash,
      // A full minute in the past, not a millisecond: `expires_at > now()` is evaluated by
      // Postgres, so a 1ms margin makes this test a hostage to clock skew between the two.
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await peekAuthToken(pool, hash, 'mfa_challenge')).toBeNull();
  });
});
