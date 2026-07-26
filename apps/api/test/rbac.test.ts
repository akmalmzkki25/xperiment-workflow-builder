import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { hasPermission, type Permission } from '../src/auth/permissions.js';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let owner: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  owner = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const ROLES = ['viewer', 'operator', 'billing', 'builder', 'admin', 'owner'] as const;
const uuid = '00000000-0000-0000-0000-0000000000aa';

/**
 * One representative route per permission. Only 403-ness is asserted: a permitted
 * call may still legitimately fail (404/409/422) for unrelated reasons.
 */
const MATRIX: { permission: Permission; method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }[] = [
  { permission: 'workflow:write', method: 'POST', url: '/v1/workflows', payload: { name: 'rbac' } },
  { permission: 'workflow:activate', method: 'POST', url: `/v1/workflows/${uuid}/activate` },
  { permission: 'execution:run', method: 'POST', url: `/v1/workflows/${uuid}/execute`, payload: {} },
  { permission: 'execution:cancel', method: 'POST', url: `/v1/executions/${uuid}/cancel` },
  { permission: 'approval:decide', method: 'POST', url: `/v1/executions/${uuid}/approvals/n`, payload: { decision: 'approve' } },
  { permission: 'connection:read', method: 'GET', url: '/v1/connections' },
  { permission: 'connection:write', method: 'POST', url: '/v1/connections', payload: { connectorKey: 'telegram', name: 'x', payload: { botToken: 't' } } },
  { permission: 'alert:write', method: 'POST', url: '/v1/alerts', payload: { name: 'a', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 1 } } },
  { permission: 'member:manage', method: 'GET', url: '/v1/workspaces/members' },
];

describe('permission matrix', () => {
  test('each role is refused exactly the permissions it lacks', async () => {
    for (const role of ROLES) {
      const member = role === 'owner' ? owner : await addMemberWithRole(app, pool, owner.workspaceId, role);
      for (const row of MATRIX) {
        const r = await member.inject({
          method: row.method,
          url: row.url,
          ...(row.payload !== undefined ? { payload: row.payload } : {}),
        });
        const allowed = hasPermission(role, row.permission);
        expect(r.statusCode === 403, `${role} ${row.method} ${row.url} (${row.permission}) → ${r.statusCode}`).toBe(
          !allowed,
        );
      }
    }
  }, 60000);

  test('an operator can cancel and approve but cannot edit a draft', async () => {
    const op = await addMemberWithRole(app, pool, owner.workspaceId, 'operator');
    const wf = (await owner.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'op' } })).json<{
      id: string;
      draftRevision: number;
    }>();
    const draft = await op.inject({
      method: 'PUT',
      url: `/v1/workflows/${wf.id}/draft`,
      payload: { definition: {} },
      headers: { 'if-match': String(wf.draftRevision) },
    });
    expect(draft.statusCode).toBe(403);
    expect((await op.inject({ method: 'POST', url: `/v1/executions/${uuid}/cancel` })).statusCode).not.toBe(403);
  });

  test('a billing member reads usage but not connections', async () => {
    const bill = await addMemberWithRole(app, pool, owner.workspaceId, 'billing');
    expect((await bill.inject({ method: 'GET', url: '/v1/usage' })).statusCode).toBe(200);
    expect((await bill.inject({ method: 'GET', url: '/v1/connections' })).statusCode).toBe(403);
  });
});

describe('member management', () => {
  test('lists members and changes a role', async () => {
    const ws = await createAuthedUser(app);
    const member = await addMemberWithRole(app, pool, ws.workspaceId, 'viewer');
    const list = await ws.inject({ method: 'GET', url: '/v1/workspaces/members' });
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ items: { userId: string; role: string }[] }>().items.find((m) => m.userId === member.userId)?.role,
    ).toBe('viewer');

    const upd = await ws.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${member.userId}`,
      payload: { role: 'operator' },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json<{ role: string }>().role).toBe('operator');
  });

  test('refuses to demote the last owner and 404s a non-member', async () => {
    const ws = await createAuthedUser(app);
    expect(
      (await ws.inject({ method: 'PUT', url: `/v1/workspaces/members/${ws.userId}`, payload: { role: 'viewer' } }))
        .statusCode,
    ).toBe(409);
    expect(
      (await ws.inject({ method: 'PUT', url: `/v1/workspaces/members/${randomUUID()}`, payload: { role: 'viewer' } }))
        .statusCode,
    ).toBe(404);
    // a malformed id must 404 rather than raise a pg 22P02
    expect(
      (await ws.inject({ method: 'PUT', url: '/v1/workspaces/members/not-a-uuid', payload: { role: 'viewer' } }))
        .statusCode,
    ).toBe(404);
  });

  test('a non-owner admin cannot grant owner', async () => {
    const ws = await createAuthedUser(app);
    const admin = await addMemberWithRole(app, pool, ws.workspaceId, 'admin');
    const target = await addMemberWithRole(app, pool, ws.workspaceId, 'viewer');
    expect(
      (await admin.inject({ method: 'PUT', url: `/v1/workspaces/members/${target.userId}`, payload: { role: 'owner' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await ws.inject({ method: 'PUT', url: `/v1/workspaces/members/${target.userId}`, payload: { role: 'owner' } }))
        .statusCode,
    ).toBe(200);
  });
});

describe('api key roles', () => {
  test('a viewer key can read but not write', async () => {
    const ws = await createAuthedUser(app);
    const created = await ws.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'ro', role: 'viewer' } });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ key: string; role: string }>().key;
    expect(created.json<{ role: string }>().role).toBe('viewer');
    const headers = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: 'GET', url: '/v1/workflows', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'nope' }, headers })).statusCode).toBe(403);
  });

  test('a key defaults to builder', async () => {
    const ws = await createAuthedUser(app);
    const key = (await ws.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'dflt' } })).json<{ key: string }>().key;
    const r = await app.inject({
      method: 'POST',
      url: '/v1/workflows',
      payload: { name: 'ok' },
      headers: { authorization: `Bearer ${key}` },
    });
    expect(r.statusCode).toBe(201);
  });
});
