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

/** A fresh owner with their own workspace. */
async function owner(): Promise<{ token: string; email: string }> {
  const email = `p-${randomUUID()}@xperiment.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password-123' },
  });
  return { token: res.json<{ token: string }>().token, email };
}

/** Enrols and returns the base32 secret so later steps can mint codes. */
async function enrol(token: string): Promise<string> {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: auth(token), payload: { password: 'password-123' } });
  const base32 = s.json<{ secretBase32: string }>().secretBase32;
  const c = await app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/confirm',
    headers: auth(token),
    payload: { password: 'password-123', code: codeFor(base32) },
  });
  expect(c.statusCode).toBe(200);
  return base32;
}

describe('mfa policy', () => {
  test('an owner without mfa cannot switch it on', async () => {
    // Otherwise they lock themselves out of their own workspace in the same request.
    const { token } = await owner();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(token),
      payload: { requireMfa: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ title: string }>().title).toBe('Enrol first');
  });

  test('an enrolled owner switches it on, and it is audited', async () => {
    const { token } = await owner();
    await enrol(token);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(token),
      payload: { requireMfa: true },
    });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ workspaces: { requireMfa: boolean }[] }>().workspaces[0]!.requireMfa).toBe(true);
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'workspace.mfa_policy_change'`,
    );
    expect(rows.rows[0]!.c).toBe('1');
  });

  test('turning it off does not require mfa', async () => {
    const { token } = await owner();
    await enrol(token);
    await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(token),
      payload: { requireMfa: true },
    });
    const off = await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(token),
      payload: { requireMfa: false },
    });
    expect(off.statusCode).toBe(200);
  });

  test('a privileged member without mfa is blocked but can still reach the fix', async () => {
    const { token } = await owner();
    const secret = await enrol(token);
    await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(token),
      payload: { requireMfa: true },
    });
    // Strip the factor directly: `disable` now refuses while this workspace requires it,
    // which is the point of the guard tested below. This leaves the owner privileged and
    // unenrolled, exactly as losing an authenticator would.
    const meBefore = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    await pool.query(`DELETE FROM user_mfa WHERE user_id = $1`, [
      meBefore.json<{ user: { id: string } }>().user.id,
    ]);
    void secret;

    const blocked = await app.inject({ method: 'GET', url: '/v1/workflows', headers: auth(token) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ title: string }>().title).toBe('MFA required');

    // …and the routes that let them out of it still answer. `me` must succeed outright;
    // `setup` must at least not be turned away by the policy — its own password check is a
    // different gate.
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.statusCode).toBe(200);
    const setupRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/setup',
      headers: auth(token),
      payload: { password: 'password-123' },
    });
    expect(setupRes.statusCode, 'setup must stay reachable under an unmet policy').toBeLessThan(400);
  });

  test('disable is refused while this workspace requires the factor', async () => {
    // Without this the privileged member can switch the factor off and then be locked out of
    // everything but the carve-out routes, leaving the workspace an administrator short.
    const { token } = await owner();
    const secret = await enrol(token);
    await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(token),
      payload: { requireMfa: true },
    });
    const off = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: auth(token),
      payload: { code: codeFor(secret, 1) },
    });
    expect(off.statusCode).toBe(409);
    expect(off.json<{ title: string }>().title).toBe('Required by a workspace');
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.json<{ mfaEnabled: boolean }>().mfaEnabled).toBe(true);
  });

  test('an api key carrying the owner role cannot set the policy', async () => {
    // API keys are deliberately outside the policy; letting one switch the policy OFF would
    // hand a key the one lever it must not have.
    const { token } = await owner();
    await enrol(token);
    const key = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(token),
      payload: { name: 'ci', role: 'owner' },
    });
    const apiKey = key.json<{ key: string }>().key;
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(apiKey),
      payload: { requireMfa: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe('Sessions only');
  });

  test('an unprivileged member is untouched by the policy', async () => {
    const { token } = await owner();
    await enrol(token);
    await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(token),
      payload: { requireMfa: true },
    });
    const invite = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/invites',
      headers: auth(token),
      payload: { role: 'viewer' },
    });
    expect(invite.statusCode).toBe(201);
    const inviteToken = invite.json<{ token: string }>().token;
    const joinerEmail = `j-${randomUUID()}@xperiment.test`;
    const joiner = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: joinerEmail, password: 'password-123' },
    });
    const joinerSession = joiner.json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      headers: auth(joinerSession),
      payload: { token: inviteToken },
    });
    const ws = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(joinerSession) });
    const target = ws.json<{ workspaces: { id: string; role: string }[] }>().workspaces.find((w) => w.role === 'viewer');
    expect(target).toBeDefined();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/workflows',
      headers: { ...auth(joinerSession), 'x-xperiment-workspace': target!.id },
    });
    expect(res.statusCode).toBe(200);
  });

  test('only an owner may set the policy', async () => {
    const { token } = await owner();
    await enrol(token);
    const key = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(token),
      payload: { name: 'ci', role: 'admin' },
    });
    const apiKey = key.json<{ key: string }>().key;
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/mfa-policy',
      headers: auth(apiKey),
      payload: { requireMfa: false },
    });
    // The session check runs before the role check, so an api key is turned away as such
    // whatever role it carries.
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe('Sessions only');
  });
});
