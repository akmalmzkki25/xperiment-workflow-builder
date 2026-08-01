import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { memoryMailSender, type MailMessage } from '../src/mail/sender.js';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
let sent: MailMessage[];

const APP_URL = 'https://app.test';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  const mail = memoryMailSender();
  sent = mail.sent;
  app = buildServer({ pool, registry: createDefaultRegistry(), mailSender: mail.sender, appUrl: APP_URL });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
  sent.length = 0;
});

/** Registers and returns the session token plus the raw verification token from the mail. */
async function register(): Promise<{ email: string; token: string; verifyToken: string }> {
  const email = `v-${randomUUID()}@xperiment.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password-123' },
  });
  expect(res.statusCode).toBe(201);
  const mail = sent.find((m) => m.to === email);
  expect(mail, 'registration should send a verification email').toBeDefined();
  const match = /token=([^\s]+)/.exec(mail!.text);
  expect(match, 'the email should carry a verification link').not.toBeNull();
  return { email, token: res.json<{ token: string }>().token, verifyToken: match![1]! };
}

async function actions(): Promise<string[]> {
  const r = await pool.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE action LIKE 'auth.email%' ORDER BY id`,
  );
  return r.rows.map((x) => x.action);
}

describe('email verification', () => {
  test('registration mails a link and me reports the address unverified', async () => {
    const { token } = await register();
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json<{ emailVerified: boolean }>().emailVerified).toBe(false);
    expect(await actions()).toContain('auth.email_verify_requested');
  });

  test('verifying flips me.emailVerified and audits it', async () => {
    const { token, verifyToken } = await register();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json<{ emailVerified: boolean }>().emailVerified).toBe(true);
    expect(await actions()).toContain('auth.email_verified');
  });

  test('a second use of the same link is a generic 400', async () => {
    const { verifyToken } = await register();
    await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    const again = await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    expect(again.statusCode).toBe(400);
    // One message for unknown, expired, consumed and wrong-purpose alike. Asserting the
    // title also catches the route silently 401ing because it was never made public.
    expect(again.json<{ title: string }>().title).toBe('Invalid or expired token');
  });

  test('an unknown token gives the same 400 as a consumed one', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: 'qv_nonsense' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe('Invalid or expired token');
  });

  test('resend issues a fresh working link', async () => {
    const { email, token } = await register();
    sent.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const mail = sent.find((m) => m.to === email);
    expect(mail).toBeDefined();
    const fresh = /token=([^\s]+)/.exec(mail!.text)![1]!;
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: fresh } })).statusCode,
    ).toBe(200);
  });

  test('registration still succeeds when the mailer throws', async () => {
    // An SMTP outage must not block every signup.
    const failing = buildServer({
      pool,
      registry: createDefaultRegistry(),
      appUrl: APP_URL,
      mailSender: {
        name: 'memory' as const,
        async send() {
          throw new Error('smtp down');
        },
      },
    });
    await failing.ready();
    const res = await failing.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `down-${randomUUID()}@xperiment.test`, password: 'password-123' },
    });
    expect(res.statusCode).toBe(201);
    await failing.close();
  });

  test('no audit row carries the raw token', async () => {
    const { verifyToken } = await register();
    await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'`,
      [verifyToken],
    );
    expect(rows.rows[0]!.c).toBe('0');
  });
});
