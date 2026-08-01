import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations, setWorkspacePlan } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createApiKeyClient, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let owner: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  owner = await createAuthedUser(app);
  // These tests seat many members in one workspace to exercise the emission sites. The
  // free plan allows 2, so without this the invite route 402s on seat quota before it ever
  // reaches the code under test. `business` is the only plan with members: null.
  await setWorkspacePlan(pool, { workspaceId: owner.workspaceId, planCode: 'business' });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, invoices CASCADE`);
});

interface AuditRow {
  action: string;
  target_type: string | null;
  target_id: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
}

/** Audit rows for one action in the owner's workspace, oldest first. */
async function rows(action: string): Promise<AuditRow[]> {
  const r = await pool.query<AuditRow>(
    `SELECT action, target_type, target_id, actor_kind, actor_user_id, actor_api_key_id, outcome, metadata
       FROM audit_events WHERE workspace_id = $1 AND action = $2 ORDER BY id`,
    [owner.workspaceId, action],
  );
  return r.rows;
}

describe('member.role_change', () => {
  test('records the previous and new role, attributed to the acting user', async () => {
    const member = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await owner.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${member.userId}`,
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    const found = await rows('member.role_change');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'user',
      target_id: member.userId,
      actor_kind: 'user',
      actor_user_id: owner.userId,
      outcome: 'success',
      metadata: { previousRole: 'viewer', newRole: 'admin' },
    });
  });

  test('a refused last-owner demotion emits nothing', async () => {
    const res = await owner.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${owner.userId}`,
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
    expect(await rows('member.role_change')).toHaveLength(0);
  });

  test('a 404 for an unknown member emits nothing', async () => {
    const res = await owner.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${randomUUID()}`,
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(404);
    expect(await rows('member.role_change')).toHaveLength(0);
  });

  test('a refused owner grant by a non-owner emits nothing', async () => {
    const admin = await addMemberWithRole(app, pool, owner.workspaceId, 'admin');
    const target = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await admin.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${target.userId}`,
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
    expect(await rows('member.role_change')).toHaveLength(0);
  });

  test('an api-key caller is recorded as the api_key actor', async () => {
    const member = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    const key = await createApiKeyClient(app, owner, 'admin');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await key.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${member.userId}`,
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(200);
    const found = await rows('member.role_change');
    expect(found[0]).toMatchObject({
      actor_kind: 'api_key',
      actor_api_key_id: key.id,
      actor_user_id: null,
    });
  });
});

describe('invite.create and invite.accept', () => {
  test('creating an invite records the role and never the token', async () => {
    const res = await owner.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'builder' } });
    expect(res.statusCode).toBe(201);
    const token = res.json<{ token: string }>().token;
    const found = await rows('invite.create');
    expect(found).toHaveLength(1);
    expect(found[0]!.target_type).toBe('invite');
    expect(found[0]!.target_id).not.toBeNull();
    expect(found[0]!.metadata).toMatchObject({ role: 'builder' });
    // The token is shown once to the caller and must never be recoverable from the log.
    expect(JSON.stringify(found[0])).not.toContain(token);
  });

  test('accepting an invite records the granted role against the same invite id', async () => {
    const created = await owner.inject({
      method: 'POST',
      url: '/v1/workspaces/invites',
      payload: { role: 'operator' },
    });
    const token = created.json<{ token: string }>().token;
    const inviteId = (await rows('invite.create'))[0]!.target_id;
    const joiner = await createAuthedUser(app);
    const res = await joiner.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token } });
    expect(res.statusCode).toBe(200);
    const found = await rows('invite.accept');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'invite',
      target_id: inviteId,
      actor_kind: 'user',
      actor_user_id: joiner.userId,
      metadata: { role: 'operator', alreadyMember: false },
    });
  });

  test('re-accepting as an existing member records alreadyMember and grants nothing', async () => {
    const member = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    const created = await owner.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'admin' } });
    const token = created.json<{ token: string }>().token;
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await member.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token } });
    expect(res.statusCode).toBe(200);
    expect((await rows('invite.accept'))[0]!.metadata).toMatchObject({ alreadyMember: true });
    // ON CONFLICT DO NOTHING: the existing role is untouched, so the row must not imply a grant.
    const role = await pool.query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [owner.workspaceId, member.userId],
    );
    expect(role.rows[0]!.role).toBe('viewer');
  });

  test('an invalid token emits nothing', async () => {
    const joiner = await createAuthedUser(app);
    const res = await joiner.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token: 'qs_nonsense' } });
    expect(res.statusCode).toBe(404);
    const any = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'invite.accept'`,
    );
    expect(any.rows[0]!.c).toBe('0');
  });

  test('a refused owner-grant invite emits nothing', async () => {
    const admin = await addMemberWithRole(app, pool, owner.workspaceId, 'admin');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await admin.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'owner' } });
    expect(res.statusCode).toBe(403);
    expect(await rows('invite.create')).toHaveLength(0);
  });
});

describe('workspace.create', () => {
  test('records the new workspace against itself, attributed to its creator', async () => {
    const creator = await createAuthedUser(app);
    const res = await creator.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: 'Second' } });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; name: string }>();
    const r = await pool.query<{ target_id: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      `SELECT target_id, actor_user_id, metadata FROM audit_events
        WHERE workspace_id = $1 AND action = 'workspace.create'`,
      [created.id],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      target_id: created.id,
      actor_user_id: creator.userId,
      metadata: { name: 'Second' },
    });
  });

  test('registration records the workspace it creates, attributed to the new user', async () => {
    // /v1/auth/register sits outside the auth plugin, so this path cannot use
    // auditActor(req) and supplies the actor explicitly.
    const email = `reg-${randomUUID()}@xperiment.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'password-123' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ user: { id: string }; workspace: { id: string } }>();
    const r = await pool.query<{ actor_user_id: string; actor_label: string | null; target_id: string }>(
      `SELECT actor_user_id, actor_label, target_id FROM audit_events
        WHERE workspace_id = $1 AND action = 'workspace.create'`,
      [body.workspace.id],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      actor_user_id: body.user.id,
      actor_label: email,
      target_id: body.workspace.id,
    });
  });

  test('an invalid name emits nothing', async () => {
    const creator = await createAuthedUser(app);
    const before = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'workspace.create'`,
    );
    const res = await creator.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    const after = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'workspace.create'`,
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });
});

describe('api_key.create and api_key.revoke', () => {
  test('creating a key records its name and role, and never the key itself', async () => {
    const res = await owner.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'CI', role: 'builder' } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; key: string }>();
    const found = await rows('api_key.create');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'api_key',
      target_id: body.id,
      actor_kind: 'user',
      metadata: { name: 'CI', role: 'builder' },
    });
    // The key is shown once and must never be recoverable from the log.
    expect(JSON.stringify(found[0])).not.toContain(body.key);
  });

  test('a key created without an explicit role records the default it actually got', async () => {
    const res = await owner.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'Default' } });
    expect(res.statusCode).toBe(201);
    // Recorded from the stored row, not from the request, so the audit matches reality.
    expect((await rows('api_key.create'))[0]!.metadata).toMatchObject({ name: 'Default', role: 'builder' });
  });

  test('revoking a key is audited, and a second revoke is a 404 that emits nothing', async () => {
    const created = await owner.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'Temp' } });
    const id = created.json<{ id: string }>().id;
    await pool.query(`TRUNCATE audit_events CASCADE`);
    expect((await owner.inject({ method: 'DELETE', url: `/v1/api-keys/${id}` })).statusCode).toBe(204);
    expect((await owner.inject({ method: 'DELETE', url: `/v1/api-keys/${id}` })).statusCode).toBe(404);
    const found = await rows('api_key.revoke');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ target_type: 'api_key', target_id: id });
  });

  test('a refused owner-role key emits nothing', async () => {
    const admin = await addMemberWithRole(app, pool, owner.workspaceId, 'admin');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await admin.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'X', role: 'owner' } });
    expect(res.statusCode).toBe(403);
    expect(await rows('api_key.create')).toHaveLength(0);
  });

  test('a viewer cannot mint a key and emits nothing', async () => {
    const viewer = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await viewer.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'Sneaky' } });
    expect(res.statusCode).toBe(403);
    expect(await rows('api_key.create')).toHaveLength(0);
  });
});

describe('plan.change', () => {
  /** A fresh workspace: `owner` is pinned to business and carries many members. */
  async function freshOwner(): Promise<AuthedUser> {
    const u = await createAuthedUser(app);
    await pool.query(`TRUNCATE audit_events CASCADE`);
    return u;
  }

  async function planRows(workspaceId: string): Promise<{ target_id: string; metadata: Record<string, unknown> }[]> {
    const r = await pool.query<{ target_id: string; metadata: Record<string, unknown> }>(
      `SELECT target_id, metadata FROM audit_events
        WHERE workspace_id = $1 AND action = 'plan.change' ORDER BY id`,
      [workspaceId],
    );
    return r.rows;
  }

  test('records the previous and new plan', async () => {
    const me = await freshOwner();
    const res = await me.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'builder' } });
    expect(res.statusCode).toBe(200);
    const found = await planRows(me.workspaceId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_id: me.workspaceId,
      metadata: { previousPlan: 'free', newPlan: 'builder' },
    });
  });

  test('an overage-only change records the flag and repeats the plan', async () => {
    const me = await freshOwner();
    await me.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'builder' } });
    await pool.query(`TRUNCATE audit_events CASCADE`);
    await me.inject({ method: 'PUT', url: '/v1/plan', payload: { allowOverage: true } });
    expect((await planRows(me.workspaceId))[0]!.metadata).toMatchObject({
      previousPlan: 'builder',
      newPlan: 'builder',
      allowOverage: true,
    });
  });

  test('a refused downgrade emits nothing', async () => {
    const me = await freshOwner();
    await me.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'team' } });
    // free allows 2 members; seat three so the downgrade must be refused.
    await addMemberWithRole(app, pool, me.workspaceId, 'viewer');
    await addMemberWithRole(app, pool, me.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await me.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'free' } });
    expect(res.statusCode).toBe(409);
    expect(await planRows(me.workspaceId)).toHaveLength(0);
  });

  test('a member without billing:manage cannot change the plan and emits nothing', async () => {
    const me = await freshOwner();
    const viewer = await addMemberWithRole(app, pool, me.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await viewer.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'builder' } });
    expect(res.statusCode).toBe(403);
    expect(await planRows(me.workspaceId)).toHaveLength(0);
  });

  test('an invalid plan code emits nothing', async () => {
    const me = await freshOwner();
    const res = await me.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'platinum' } });
    expect(res.statusCode).toBe(400);
    expect(await planRows(me.workspaceId)).toHaveLength(0);
  });
});

describe('invoice.pay and invoice.mark_paid', () => {
  // invoices carries UNIQUE (workspace_id, period_start), so each seed needs its own month.
  let period = 0;

  async function seedIssuedInvoice(): Promise<string> {
    period += 1;
    const month = String((period % 12) + 1).padStart(2, '0');
    const next = String(((period + 1) % 12) + 1).padStart(2, '0');
    const r = await pool.query<{ id: string }>(
      `INSERT INTO invoices (workspace_id, period_start, period_end, plan_code, currency,
         subtotal_minor, tax_rate_bps, tax_minor, total_minor, status)
       VALUES ($1, $2, $3, 'builder', 'IDR', 149000, 1100, 16390, 165390, 'issued')
       RETURNING id`,
      [owner.workspaceId, `2026-${month}-01`, `2026-${next}-01`],
    );
    return r.rows[0]!.id;
  }

  test('marking an invoice paid is audited with its amount', async () => {
    const id = await seedIssuedInvoice();
    const res = await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    expect(res.statusCode).toBe(200);
    const found = await rows('invoice.mark_paid');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'invoice',
      target_id: id,
      actor_kind: 'user',
      metadata: { totalMinor: 165390, currency: 'IDR' },
    });
  });

  test('a replayed mark-paid is a 409 that emits nothing more', async () => {
    const id = await seedIssuedInvoice();
    await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    const again = await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    expect(again.statusCode).toBe(409);
    // The CAS settles nothing on replay, so exactly one row survives.
    expect(await rows('invoice.mark_paid')).toHaveLength(1);
  });

  test('paying an invoice is audited with the provider', async () => {
    const id = await seedIssuedInvoice();
    const res = await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` });
    expect(res.statusCode).toBe(200);
    const found = await rows('invoice.pay');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_id: id,
      metadata: { provider: 'manual', currency: 'IDR', totalMinor: 165390 },
    });
  });

  test('an unknown invoice emits nothing', async () => {
    const res = await owner.inject({ method: 'POST', url: `/v1/invoices/${randomUUID()}/mark-paid` });
    expect(res.statusCode).toBe(404);
    expect(await rows('invoice.mark_paid')).toHaveLength(0);
  });

  test('a member without billing:manage cannot settle and emits nothing', async () => {
    const id = await seedIssuedInvoice();
    const viewer = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await viewer.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    expect(res.statusCode).toBe(403);
    expect(await rows('invoice.mark_paid')).toHaveLength(0);
  });
});
