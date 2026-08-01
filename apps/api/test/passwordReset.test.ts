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

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  const mail = memoryMailSender();
  sent = mail.sent;
  app = buildServer({
    pool,
    registry: createDefaultRegistry(),
    mailSender: mail.sender,
    appUrl: 'https://app.test',
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
  sent.length = 0;
});

async function newAccount(): Promise<{ email: string; token: string }> {
  const email = `r-${randomUUID()}@xperiment.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password-123' },
  });
  sent.length = 0; // drop the verification mail
  return { email, token: res.json<{ token: string }>().token };
}

/** Runs forgot-password and returns the raw reset token from the mail. */
async function requestReset(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload: { email } });
  expect(res.statusCode).toBe(200);
  const mail = sent.find((m) => m.to === email && m.subject.includes('Reset'));
  expect(mail, 'a known address should be mailed').toBeDefined();
  return /token=([^\s]+)/.exec(mail!.text)![1]!;
}

describe('forgot-password', () => {
  test('an unknown address gets the same 200, sends nothing and emits nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: `ghost-${randomUUID()}@xperiment.test` },
    });
    // A 404 here would turn the endpoint into a membership oracle.
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(0);
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.password_reset_requested'`,
    );
    expect(rows.rows[0]!.c).toBe('0');
  });

  test('a known address is mailed a link and the request is audited', async () => {
    const { email } = await newAccount();
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const token = await requestReset(email);
    expect(token.startsWith('qr_')).toBe(true);
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.password_reset_requested'`,
    );
    expect(rows.rows[0]!.c).toBe('1');
  });
});

describe('reset-password', () => {
  test('sets the new password and lets the user log in with it', async () => {
    const { email } = await newAccount();
    const token = await requestReset(email);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'brand-new-456' },
    });
    expect(res.statusCode).toBe(200);
    const good = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'brand-new-456' },
    });
    expect(good.statusCode).toBe(200);
    const old = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password-123' },
    });
    expect(old.statusCode).toBe(401);
  });

  test('every existing session stops working', async () => {
    // Without this an attacker holding a stolen session keeps it after the victim resets,
    // which makes the whole reset theatre.
    const { email, token: session } = await newAccount();
    const before = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(before.statusCode).toBe(200);
    const reset = await requestReset(email);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: reset, password: 'another-789' },
    });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(after.statusCode).toBe(401);
  });

  test('a second use of the same reset link is a generic 400', async () => {
    const { email } = await newAccount();
    const token = await requestReset(email);
    await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token, password: 'first-pass-1' } });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'second-pass-2' },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json<{ title: string }>().title).toBe('Invalid or expired token');
  });

  test('an earlier outstanding reset link is burnt by a later completed reset', async () => {
    const { email } = await newAccount();
    const first = await requestReset(email);
    sent.length = 0;
    const second = await requestReset(email);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: second, password: 'winner-111' },
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: first, password: 'loser-222' },
    });
    expect(stale.statusCode).toBe(400);
  });

  test('a verification token cannot be used to reset a password', async () => {
    const email = `x-${randomUUID()}@xperiment.test`;
    await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'password-123' } });
    const verifyToken = /token=([^\s]+)/.exec(sent.find((m) => m.to === email)!.text)![1]!;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: verifyToken, password: 'hijacked-333' },
    });
    expect(res.statusCode).toBe(400);
    // …and the original password still works.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password-123' },
    });
    expect(login.statusCode).toBe(200);
  });

  test('a short password is refused before the token is spent', async () => {
    const { email } = await newAccount();
    const token = await requestReset(email);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token, password: 'short' } }))
        .statusCode,
    ).toBe(400);
    // The token survives, so a typo does not cost the user their only link.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/reset-password',
          payload: { token, password: 'long-enough-9' },
        })
      ).statusCode,
    ).toBe(200);
  });

  test('completion is audited, carries no raw token, and stays account-level', async () => {
    const { email } = await newAccount();
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const token = await requestReset(email);
    await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token, password: 'audited-444' } });
    const rows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action LIKE 'auth.password_reset%' ORDER BY id`,
    );
    expect(rows.rows.map((r) => r.action)).toEqual([
      'auth.password_reset_requested',
      'auth.password_reset_completed',
    ]);

    const leak = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'`,
      [token],
    );
    expect(leak.rows[0]!.c).toBe('0');

    const scoped = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action LIKE 'auth.%' AND workspace_id IS NOT NULL`,
    );
    // Account-level events pre-date any workspace context, and §7 of the P design relies on
    // a null workspace to keep them out of every workspace's audit view. The emission code
    // simply omits workspaceId, so without this a later edit adding one would go unnoticed.
    expect(scoped.rows[0]!.c).toBe('0');
  });
});
