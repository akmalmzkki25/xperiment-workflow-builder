import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
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
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
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
