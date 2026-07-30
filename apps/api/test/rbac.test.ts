import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ALL_PERMISSIONS, hasPermission, type Permission } from '../src/auth/permissions.js';
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
const MATRIX: {
  permission: Permission;
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  payload?: Record<string, unknown>;
}[] = [
  { permission: 'workflow:read', method: 'GET', url: '/v1/workflows' },
  { permission: 'workflow:read', method: 'GET', url: `/v1/workflows/${uuid}` },
  { permission: 'workflow:read', method: 'GET', url: `/v1/workflows/${uuid}/triggers` },
  { permission: 'workflow:read', method: 'GET', url: `/v1/workflows/${uuid}/diff?from=draft&to=v` },
  { permission: 'workflow:read', method: 'POST', url: `/v1/workflows/${uuid}/validate` },
  { permission: 'execution:read', method: 'GET', url: '/v1/executions' },
  { permission: 'execution:read', method: 'GET', url: `/v1/executions/${uuid}` },
  { permission: 'execution:read', method: 'GET', url: '/v1/approvals' },
  { permission: 'alert:read', method: 'GET', url: '/v1/alerts' },
  { permission: 'alert:read', method: 'GET', url: '/v1/alerts/events' },
  { permission: 'usage:read', method: 'GET', url: '/v1/usage' },
  { permission: 'workflow:write', method: 'POST', url: '/v1/workflows', payload: { name: 'rbac' } },
  { permission: 'workflow:activate', method: 'POST', url: `/v1/workflows/${uuid}/activate` },
  { permission: 'execution:run', method: 'POST', url: `/v1/workflows/${uuid}/execute`, payload: {} },
  { permission: 'execution:cancel', method: 'POST', url: `/v1/executions/${uuid}/cancel` },
  { permission: 'approval:decide', method: 'POST', url: `/v1/executions/${uuid}/approvals/n`, payload: { decision: 'approve' } },
  { permission: 'connection:read', method: 'GET', url: '/v1/connections' },
  { permission: 'connection:write', method: 'POST', url: '/v1/connections', payload: { connectorKey: 'telegram', name: 'x', payload: { botToken: 't' } } },
  { permission: 'alert:write', method: 'POST', url: '/v1/alerts', payload: { name: 'a', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 1 } } },
  { permission: 'member:manage', method: 'GET', url: '/v1/workspaces/members' },
  { permission: 'billing:read', method: 'GET', url: '/v1/plan' },
  { permission: 'billing:manage', method: 'PUT', url: '/v1/plan', payload: { allowOverage: false } },
  { permission: 'billing:read', method: 'GET', url: '/v1/invoices' },
  { permission: 'billing:read', method: 'GET', url: `/v1/invoices/${uuid}` },
  { permission: 'billing:manage', method: 'POST', url: `/v1/invoices/${uuid}/pay` },
  { permission: 'billing:manage', method: 'POST', url: `/v1/invoices/${uuid}/mark-paid` },
  { permission: 'audit:read', method: 'GET', url: '/v1/audit' },
];

/** Every declared permission is now routed. */
const UNROUTED: Permission[] = [];

describe('permission matrix', () => {
  test('every declared permission is exercised by the matrix', () => {
    const covered = new Set(MATRIX.map((m) => m.permission));
    for (const p of ALL_PERMISSIONS) {
      expect(covered.has(p) || UNROUTED.includes(p), `${p} has no matrix row`).toBe(true);
    }
  });

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

  test('a trigger URL and secret reach an activator but not a plain reader', async () => {
    const wf = (await owner.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'trig' } })).json<{
      id: string;
    }>();
    await pool.query(
      `INSERT INTO workflow_triggers (workspace_id, workflow_id, node_id, type, route_key, auth_mode, active)
       VALUES ($1,$2,'hook','webhook',$3,'none',true)`,
      [owner.workspaceId, wf.id, `rk-${randomUUID()}`],
    );

    const asOwner = await owner.inject({ method: 'GET', url: `/v1/workflows/${wf.id}/triggers` });
    const ownerTrigger = asOwner.json<{ triggers: Record<string, unknown>[] }>().triggers[0]!;
    expect(ownerTrigger['url']).toBeTruthy();

    // A viewer holds workflow:read but not workflow:activate. Handing them the route
    // URL (or a signing secret) would let them start production runs via the gateway.
    const viewer = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    const asViewer = await viewer.inject({ method: 'GET', url: `/v1/workflows/${wf.id}/triggers` });
    expect(asViewer.statusCode).toBe(200);
    const viewerTrigger = asViewer.json<{ triggers: Record<string, unknown>[] }>().triggers[0]!;
    expect(viewerTrigger['nodeId']).toBe('hook');
    expect(viewerTrigger).not.toHaveProperty('url');
    expect(viewerTrigger).not.toHaveProperty('testUrl');
    expect(viewerTrigger).not.toHaveProperty('secret');
  });

  test('a billing member reads usage and alerts but no workflow or execution data', async () => {
    const bill = await addMemberWithRole(app, pool, owner.workspaceId, 'billing');
    expect((await bill.inject({ method: 'GET', url: '/v1/usage' })).statusCode).toBe(200);
    expect((await bill.inject({ method: 'GET', url: '/v1/alerts' })).statusCode).toBe(200);
    expect((await bill.inject({ method: 'GET', url: '/v1/connections' })).statusCode).toBe(403);
    // An external bookkeeper must not read customer payloads (execution timelines) or IR.
    expect((await bill.inject({ method: 'GET', url: '/v1/executions' })).statusCode).toBe(403);
    expect((await bill.inject({ method: 'GET', url: `/v1/executions/${uuid}` })).statusCode).toBe(403);
    expect((await bill.inject({ method: 'GET', url: '/v1/workflows' })).statusCode).toBe(403);
    expect((await bill.inject({ method: 'GET', url: `/v1/workflows/${uuid}` })).statusCode).toBe(403);
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
