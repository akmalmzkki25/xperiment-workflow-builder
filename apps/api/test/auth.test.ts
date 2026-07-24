import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('auth flows', () => {
  test('register issues a working token; duplicate email 409; weak password 400', async () => {
    const email = `r-${randomUUID()}@xperiment.test`;
    const r = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'password-123' } });
    expect(r.statusCode).toBe(201);
    const { token } = r.json<{ token: string }>();
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ workspaces: unknown[] }>().workspaces).toHaveLength(1);
    const dup = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'password-123' } });
    expect(dup.statusCode).toBe(409);
    const weak = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `w-${randomUUID()}@xperiment.test`, password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
  });

  test('login works; wrong password is generic 401 and audited; 6th rapid attempt 429', async () => {
    const user = await createAuthedUser(app);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ token: string }>().token.startsWith('qs_')).toBe(true);

    const attackEmail = `a-${randomUUID()}@xperiment.test`;
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: attackEmail, password: 'password-wrong' },
      });
      last = r.statusCode;
    }
    expect(last).toBe(429);
    const audited = await pool.query(`SELECT count(*)::int AS c FROM auth_events WHERE email = $1 AND event_type = 'login_failed'`, [
      attackEmail,
    ]);
    expect((audited.rows[0] as { c: number }).c).toBeGreaterThanOrEqual(4);
  });

  test('logout revokes the session; logout-all revokes every session', async () => {
    const user = await createAuthedUser(app);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    const secondToken = second.json<{ token: string }>().token;
    await user.inject({ method: 'POST', url: '/v1/auth/logout' });
    expect((await user.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
    const stillOk = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${secondToken}` } });
    expect(stillOk.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${secondToken}` } }))
        .statusCode,
    ).toBe(401);
  });

  test('missing or malformed bearer is 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/workflows' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/workflows', headers: { authorization: 'Bearer nonsense' } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('workspaces, invites, roles, api keys', () => {
  test('invite flow: admin invites, second user accepts with the granted role', async () => {
    const owner = await createAuthedUser(app);
    const joiner = await createAuthedUser(app);
    const invite = await owner.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'viewer' } });
    expect(invite.statusCode).toBe(201);
    const inviteToken = invite.json<{ token: string }>().token;
    const accept = await joiner.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token: inviteToken } });
    expect(accept.json<{ workspaceId: string }>().workspaceId).toBe(owner.workspaceId);

    // Viewer in owner's workspace cannot create workflows there.
    const forbidden = await joiner.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: { 'x-xperiment-workspace': owner.workspaceId },
      payload: { name: 'nope' },
    });
    expect(forbidden.statusCode).toBe(403);
    // But reads are fine.
    const reads = await joiner.inject({
      method: 'GET',
      url: '/v1/workflows',
      headers: { 'x-xperiment-workspace': owner.workspaceId },
    });
    expect(reads.statusCode).toBe(200);
    // Reusing the invite fails.
    expect((await joiner.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token: inviteToken } })).statusCode).toBe(404);
  });

  test('workspace switching requires membership', async () => {
    const a = await createAuthedUser(app);
    const b = await createAuthedUser(app);
    const denied = await b.inject({
      method: 'GET',
      url: '/v1/workflows',
      headers: { 'x-xperiment-workspace': a.workspaceId },
    });
    expect(denied.statusCode).toBe(403);
  });

  test('api keys: shown once, authenticate as builder, revocable', async () => {
    const owner = await createAuthedUser(app);
    const created = await owner.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'ci' } });
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json<{ id: string; key: string }>();
    expect(key.startsWith('qk_')).toBe(true);
    const listed = await owner.inject({ method: 'GET', url: '/v1/api-keys' });
    expect(JSON.stringify(listed.json())).not.toContain(key);

    const viaKey = await app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'via api key' },
    });
    expect(viaKey.statusCode).toBe(201);
    const meDenied = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${key}` } });
    expect(meDenied.statusCode).toBe(400); // sessions only

    await owner.inject({ method: 'DELETE', url: `/v1/api-keys/${id}` });
    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/v1/workflows',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });
});
