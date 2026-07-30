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
    const audited = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit_events
        WHERE actor_label = $1 AND action = 'auth.login_failed' AND outcome = 'failure'`,
      [attackEmail],
    );
    expect(audited.rows[0]!.c).toBeGreaterThanOrEqual(4);
  });

  test('a failed login for an unknown email is global, not attributed to a workspace', async () => {
    const ghost = `ghost-${randomUUID()}@xperiment.test`;
    await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: ghost, password: 'whatever-123' } });
    const row = await pool.query<{ workspace_id: string | null; actor_kind: string; actor_user_id: string | null }>(
      `SELECT workspace_id, actor_kind, actor_user_id FROM audit_events WHERE actor_label = $1`,
      [ghost],
    );
    expect(row.rows[0]).toMatchObject({ workspace_id: null, actor_kind: 'anonymous', actor_user_id: null });
  });

  test('register and a successful login are attributed to the user, with no password material', async () => {
    const email = `aud-${randomUUID()}@xperiment.test`;
    const password = 'password-123';
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } });
    const userId = reg.json<{ user: { id: string } }>().user.id;
    await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
    const rows = await pool.query<{ action: string; actor_kind: string; actor_user_id: string; metadata: unknown }>(
      `SELECT action, actor_kind, actor_user_id, metadata FROM audit_events WHERE actor_label = $1 ORDER BY id`,
      [email],
    );
    expect(rows.rows.map((r) => r.action)).toEqual(['auth.register', 'auth.login_succeeded']);
    for (const r of rows.rows) {
      expect(r.actor_kind).toBe('user');
      expect(r.actor_user_id).toBe(userId);
      expect(JSON.stringify(r.metadata)).not.toContain(password);
    }
  });

  test('logout is attributed to the workspace the session was acting in', async () => {
    const user = await createAuthedUser(app);
    await user.inject({ method: 'POST', url: '/v1/auth/logout' });
    const row = await pool.query<{ workspace_id: string | null; action: string }>(
      `SELECT workspace_id, action FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.logout'`,
      [user.userId],
    );
    expect(row.rows[0]).toMatchObject({ workspace_id: user.workspaceId, action: 'auth.logout' });
  });

  test('auth_events receives no new writes', async () => {
    const before = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM auth_events`);
    const user = await createAuthedUser(app);
    await user.inject({ method: 'POST', url: '/v1/auth/logout-all' });
    const after = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM auth_events`);
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
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

  test('workspace create/list and invalid bodies', async () => {
    const user = await createAuthedUser(app);
    const created = await user.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: 'Second' } });
    expect(created.statusCode).toBe(201);
    const list = await user.inject({ method: 'GET', url: '/v1/workspaces' });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2);
    expect((await user.inject({ method: 'POST', url: '/v1/workspaces', payload: {} })).statusCode).toBe(400);
    expect(
      (await user.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'nope' } })).statusCode,
    ).toBe(400); // unknown role
    expect(
      (await user.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'owner' } })).statusCode,
    ).toBe(201); // an owner may invite a co-owner
    expect(
      (await user.inject({ method: 'POST', url: '/v1/invites/accept', payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (await user.inject({ method: 'POST', url: '/v1/api-keys', payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (await user.inject({ method: 'DELETE', url: `/v1/api-keys/00000000-0000-0000-0000-0000000000aa` })).statusCode,
    ).toBe(404);
  });

  test('api-key contexts are rejected from session-only workspace routes', async () => {
    const user = await createAuthedUser(app);
    const created = await user.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'k' } });
    const key = created.json<{ key: string }>().key;
    const viaKey = (url: string, method = 'POST', payload?: unknown) =>
      app.inject({ method: method as 'POST', url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });
    expect((await viaKey('/v1/workspaces', 'POST', { name: 'x' })).statusCode).toBe(400);
    expect((await viaKey('/v1/workspaces', 'GET')).statusCode).toBe(400);
    expect((await viaKey('/v1/invites/accept', 'POST', { token: 'x' })).statusCode).toBe(400);
    expect((await viaKey('/v1/auth/logout-all', 'POST')).statusCode).toBe(400);
    // API key has builder role -> admin-gated routes are 403.
    expect((await viaKey('/v1/api-keys', 'GET')).statusCode).toBe(403);
    expect((await viaKey('/v1/workspaces/invites', 'POST', { role: 'viewer' })).statusCode).toBe(403);
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
