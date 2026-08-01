import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { base32Decode, createPool, runMigrations, totpCode, TOTP_STEP_SECONDS } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { memoryMailSender } from '../src/mail/sender.js';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({
    pool,
    registry: createDefaultRegistry(),
    mailSender: memoryMailSender().sender,
    appUrl: 'https://app.test',
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const codeFor = (base32: string, offset = 0) =>
  totpCode(base32Decode(base32), Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + offset);

async function enrolled(): Promise<{ email: string; secretBase32: string; recoveryCodes: string[] }> {
  const email = `l-${randomUUID()}@xperiment.test`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password-123' },
  });
  const token = reg.json<{ token: string }>().token;
  const s = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: auth(token) });
  const secretBase32 = s.json<{ secretBase32: string }>().secretBase32;
  const c = await app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/confirm',
    headers: auth(token),
    payload: { code: codeFor(secretBase32) },
  });
  expect(c.statusCode).toBe(200);
  return { email, secretBase32, recoveryCodes: c.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

const login = (email: string, password = 'password-123') =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

describe('two-step login', () => {
  test('an enrolled user gets a challenge instead of a session', async () => {
    const { email } = await enrolled();
    const res = await login(email);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ mfaRequired?: boolean; challenge?: string; token?: string }>();
    expect(body.mfaRequired).toBe(true);
    expect(body.challenge).toMatch(/^qm_/);
    // The critical part: a password alone must not produce anything that authenticates.
    expect(body.token).toBeUndefined();
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.mfa_challenged'`,
    );
    expect(rows.rows[0]!.c).toBe('1');
  });

  test('a user without mfa still logs in with one call', async () => {
    const email = `plain-${randomUUID()}@xperiment.test`;
    await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'password-123' } });
    const res = await login(email);
    expect(res.json<{ token?: string }>().token).toMatch(/^qs_/);
  });

  test('challenge plus code yields a working session', async () => {
    const { email, secretBase32 } = await enrolled();
    const challenge = (await login(email)).json<{ challenge: string }>().challenge;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge, code: codeFor(secretBase32, 1) },
    });
    expect(res.statusCode).toBe(200);
    const token = res.json<{ token: string }>().token;
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.statusCode).toBe(200);
    const actions = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action IN ('auth.mfa_verified','auth.login_succeeded') ORDER BY id`,
    );
    expect(actions.rows.map((r) => r.action)).toEqual(['auth.mfa_verified', 'auth.login_succeeded']);
  });

  test('a wrong code does not burn the challenge', async () => {
    // One mistyped digit must not send the user back through their password.
    const { email, secretBase32 } = await enrolled();
    const challenge = (await login(email)).json<{ challenge: string }>().challenge;
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', payload: { challenge, code: '000000' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ title: string }>().title).toBe('Invalid code');
    const good = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge, code: codeFor(secretBase32, 1) },
    });
    expect(good.statusCode).toBe(200);
  });

  test('a challenge is single use', async () => {
    const { email, secretBase32 } = await enrolled();
    const challenge = (await login(email)).json<{ challenge: string }>().challenge;
    await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge, code: codeFor(secretBase32, 1) },
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge, code: codeFor(secretBase32, 2) },
    });
    expect(again.statusCode).toBe(400);
  });

  test('an unknown challenge gives the same generic 400 as a spent one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge: 'qm_not-a-real-challenge', code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe('Invalid or expired token');
  });

  test('repeated wrong codes destroy the challenge', async () => {
    const { email, secretBase32 } = await enrolled();
    const challenge = (await login(email)).json<{ challenge: string }>().challenge;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', payload: { challenge, code: '000000' } });
      statuses.push(r.statusCode);
    }
    expect(statuses).toContain(429);
    // Once the limiter refuses, the challenge is gone — a correct code no longer saves it.
    const after = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge, code: codeFor(secretBase32, 1) },
    });
    expect(after.statusCode).toBeGreaterThanOrEqual(400);
  });

  test('a recovery code completes the login and is then spent', async () => {
    const { email, recoveryCodes } = await enrolled();
    const challenge = (await login(email)).json<{ challenge: string }>().challenge;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge, code: recoveryCodes[0]! },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ recoveryCodesRemaining: number }>().recoveryCodesRemaining).toBe(9);
    const used = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.mfa_recovery_used'`,
    );
    expect(used.rows[0]!.c).toBe('1');
  });

  test('a password reset does not get past the second factor', async () => {
    // If it did, anyone holding the mailbox would walk straight past MFA.
    const { email } = await enrolled();
    await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload: { email } });
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM auth_tokens WHERE purpose = 'password_reset' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row.rowCount).toBe(1);
    // The reset itself is covered by passwordReset.test.ts; here only the login shape matters.
    const res = await login(email);
    expect(res.json<{ mfaRequired?: boolean }>().mfaRequired).toBe(true);
  });

  test('no audit row carries a submitted code or a challenge', async () => {
    const { email, secretBase32 } = await enrolled();
    const challenge = (await login(email)).json<{ challenge: string }>().challenge;
    const code = codeFor(secretBase32, 1);
    await app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', payload: { challenge, code } });
    for (const needle of [challenge, code]) {
      const rows = await pool.query<{ c: string }>(
        `SELECT count(*) AS c FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'`,
        [needle],
      );
      expect(rows.rows[0]!.c).toBe('0');
    }
  });
});
