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

/** Registers a user and returns their session token. */
async function newAccount(): Promise<{ email: string; token: string }> {
  const email = `m-${randomUUID()}@xperiment.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password-123' },
  });
  expect(res.statusCode).toBe(201);
  return { email, token: res.json<{ token: string }>().token };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A code valid right now for the base32 secret the setup route handed out. */
function codeFor(base32: string, offsetSteps = 0): string {
  const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + offsetSteps;
  return totpCode(base32Decode(base32), step);
}

async function setup(token: string): Promise<{ secretBase32: string; otpauthUri: string }> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: auth(token), payload: { password: 'password-123' } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('mfa setup', () => {
  test('hands out a secret and a scannable uri', async () => {
    const { token, email } = await newAccount();
    const body = await setup(token);
    expect(body.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUri).toContain(`secret=${body.secretBase32}`);
    expect(body.otpauthUri).toContain(encodeURIComponent(email));
  });

  test('the pending secret is not yet a second factor', async () => {
    const { token } = await newAccount();
    await setup(token);
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ mfaEnabled: boolean }>().mfaEnabled).toBe(false);
  });

  test('an api key cannot enrol', async () => {
    const { token } = await newAccount();
    const key = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(token),
      payload: { name: 'ci', role: 'admin' },
    });
    const apiKey = key.json<{ key: string }>().key;
    const res = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: auth(apiKey), payload: { password: 'password-123' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('mfa confirm', () => {
  test('a correct code turns the factor on and returns ten recovery codes once', async () => {
    const { token } = await newAccount();
    const { secretBase32 } = await setup(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: auth(token),
      payload: { password: 'password-123', code: codeFor(secretBase32) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ recoveryCodes: string[] }>();
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set(body.recoveryCodes).size).toBe(10);

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ mfaEnabled: boolean }>().mfaEnabled).toBe(true);

    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.mfa_enabled'`,
    );
    expect(rows.rows[0]!.c).toBe('1');
  });

  test('a wrong code leaves the factor off', async () => {
    const { token } = await newAccount();
    await setup(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: auth(token),
      payload: { password: 'password-123', code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe('Invalid code');
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ mfaEnabled: boolean }>().mfaEnabled).toBe(false);
  });

  test('confirming without a setup is refused', async () => {
    const { token } = await newAccount();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: auth(token),
      payload: { password: 'password-123', code: '000000' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('setup is refused once the factor is confirmed', async () => {
    const { token } = await newAccount();
    const { secretBase32 } = await setup(token);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: auth(token),
      payload: { password: 'password-123', code: codeFor(secretBase32) },
    });
    const again = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: auth(token), payload: { password: 'password-123' } });
    expect(again.statusCode).toBe(409);
  });

  test('no audit row carries the secret or a recovery code', async () => {
    const { token } = await newAccount();
    const { secretBase32 } = await setup(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: auth(token),
      payload: { password: 'password-123', code: codeFor(secretBase32) },
    });
    const first = res.json<{ recoveryCodes: string[] }>().recoveryCodes[0]!;
    for (const needle of [secretBase32, first]) {
      const rows = await pool.query<{ c: string }>(
        `SELECT count(*) AS c FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'`,
        [needle],
      );
      expect(rows.rows[0]!.c).toBe('0');
    }
  });
});

/** Registers, enrols and returns everything the later tests need. */
async function enrolled(): Promise<{ email: string; token: string; secretBase32: string; recoveryCodes: string[] }> {
  const { email, token } = await newAccount();
  const { secretBase32 } = await setup(token);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/confirm',
    headers: auth(token),
    payload: { password: 'password-123', code: codeFor(secretBase32) },
  });
  expect(res.statusCode).toBe(200);
  return { email, token, secretBase32, recoveryCodes: res.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

describe('mfa disable', () => {
  test('a session alone cannot switch the factor off', async () => {
    // Otherwise a stolen session removes the very control that was meant to contain it.
    const { token } = await enrolled();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/mfa/disable', headers: auth(token), payload: {} });
    expect(res.statusCode).toBe(400);
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ mfaEnabled: boolean }>().mfaEnabled).toBe(true);
  });

  test('a live totp code switches it off and audits that', async () => {
    const { token, secretBase32 } = await enrolled();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: auth(token),
      // One step ahead: confirm already spent the current step, and the replay floor holds.
      payload: { code: codeFor(secretBase32, 1) },
    });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ mfaEnabled: boolean }>().mfaEnabled).toBe(false);
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.mfa_disabled'`,
    );
    expect(rows.rows[0]!.c).toBe('1');
  });

  test('a recovery code also switches it off', async () => {
    const { token, recoveryCodes } = await enrolled();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: auth(token),
      payload: { code: recoveryCodes[0]! },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('mfa recovery-codes', () => {
  test('regenerating needs a live code and invalidates the old set', async () => {
    const { token, secretBase32, recoveryCodes } = await enrolled();
    const bare = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery-codes',
      headers: auth(token),
      payload: {},
    });
    expect(bare.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery-codes',
      headers: auth(token),
      payload: { code: codeFor(secretBase32, 1) },
    });
    expect(res.statusCode).toBe(200);
    const fresh = res.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[0]!);

    // An old code must not still open the door.
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: auth(token),
      payload: { code: recoveryCodes[0]! },
    });
    expect(stale.statusCode).toBe(400);
  });

  test('a spent recovery code cannot be spent twice', async () => {
    const { token, recoveryCodes } = await enrolled();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery-codes',
      headers: auth(token),
      payload: { code: recoveryCodes[0]! },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery-codes',
      headers: auth(token),
      payload: { code: recoveryCodes[0]! },
    });
    expect(again.statusCode).toBe(400);
  });
});

describe('enrolment requires the password', () => {
  test('a session alone cannot start enrolment', async () => {
    // A stolen session must not be able to attach a factor: a password reset revokes sessions
    // but leaves MFA standing, so the real owner would reset, sign in, and be challenged for a
    // code only the attacker holds — and no one can reset it for them.
    const { token } = await newAccount();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: auth(token), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  test('a wrong password is refused at setup', async () => {
    const { token } = await newAccount();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/setup',
      headers: auth(token),
      payload: { password: 'not-the-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  test('a wrong password is refused at confirm, leaving the factor off', async () => {
    const { token } = await newAccount();
    const { secretBase32 } = await setup(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: auth(token),
      payload: { password: 'not-the-password', code: codeFor(secretBase32) },
    });
    expect(res.statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ mfaEnabled: boolean }>().mfaEnabled).toBe(false);
  });

  test('repeated wrong passwords are rate limited, so this is no password oracle', async () => {
    const { token } = await newAccount();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/setup',
        headers: auth(token),
        payload: { password: `guess-${i}` },
      });
      statuses.push(r.statusCode);
    }
    expect(statuses).toContain(429);
  });
});
