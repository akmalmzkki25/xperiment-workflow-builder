import { createDefaultRegistry } from '@xperiment/connectors';
import { appendAuditEvent, createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let owner: AuthedUser;
let viewer: AuthedUser;
let stranger: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  owner = await createAuthedUser(app);
  viewer = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
  // A separate registration gets its own workspace.
  stranger = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
});

describe('GET /v1/audit', () => {
  test('an owner reads their workspace’s events, newest first', async () => {
    await appendAuditEvent(pool, {
      workspaceId: owner.workspaceId,
      actorKind: 'system',
      action: 'credential.read_use',
      targetType: 'connection',
      targetId: 'c-1',
    });
    await appendAuditEvent(pool, {
      workspaceId: owner.workspaceId,
      actorKind: 'system',
      action: 'credential.create',
      targetType: 'connection',
      targetId: 'c-2',
    });
    const res = await owner.inject({ method: 'GET', url: '/v1/audit' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { action: string; targetId: string }[]; nextBefore: string | null }>();
    expect(body.items.map((i) => i.targetId)).toEqual(['c-2', 'c-1']);
    expect(body.nextBefore).toBeNull(); // fewer rows than the page size
  });

  test('a viewer is refused, and the message names the permission', async () => {
    const res = await viewer.inject({ method: 'GET', url: '/v1/audit' });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('audit:read');
  });

  test('another workspace’s events are invisible', async () => {
    await appendAuditEvent(pool, {
      workspaceId: stranger.workspaceId,
      actorKind: 'system',
      action: 'credential.create',
    });
    const res = await owner.inject({ method: 'GET', url: '/v1/audit' });
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  test('a global event is never returned', async () => {
    await appendAuditEvent(pool, { actorKind: 'anonymous', action: 'auth.login_failed', outcome: 'failure' });
    const res = await owner.inject({ method: 'GET', url: '/v1/audit' });
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  test('nextBefore drives the next page and the pages do not overlap', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendAuditEvent(pool, {
        workspaceId: owner.workspaceId,
        actorKind: 'system',
        action: 'credential.read_use',
        targetId: `c-${i}`,
      });
    }
    const first = await owner.inject({ method: 'GET', url: '/v1/audit?limit=2' });
    const page1 = first.json<{ items: { targetId: string }[]; nextBefore: string | null }>();
    expect(page1.items.map((i) => i.targetId)).toEqual(['c-4', 'c-3']);
    expect(page1.nextBefore).not.toBeNull();
    const second = await owner.inject({ method: 'GET', url: `/v1/audit?limit=2&before=${page1.nextBefore}` });
    expect(second.json<{ items: { targetId: string }[] }>().items.map((i) => i.targetId)).toEqual(['c-2', 'c-1']);
  });

  test('filters by action and by target', async () => {
    await appendAuditEvent(pool, {
      workspaceId: owner.workspaceId,
      actorKind: 'system',
      action: 'credential.create',
      targetType: 'connection',
      targetId: 'c-1',
    });
    await appendAuditEvent(pool, {
      workspaceId: owner.workspaceId,
      actorKind: 'system',
      action: 'credential.read_use',
      targetType: 'connection',
      targetId: 'c-2',
    });
    const byAction = await owner.inject({ method: 'GET', url: '/v1/audit?action=credential.create' });
    expect(byAction.json<{ items: { targetId: string }[] }>().items.map((i) => i.targetId)).toEqual(['c-1']);
    const byTarget = await owner.inject({ method: 'GET', url: '/v1/audit?targetType=connection&targetId=c-2' });
    expect(byTarget.json<{ items: { action: string }[] }>().items.map((i) => i.action)).toEqual([
      'credential.read_use',
    ]);
  });

  test('a non-numeric cursor is a 400, not a 500', async () => {
    // There is no Fastify setErrorHandler in this app, so an unguarded value reaching a
    // ::bigint parameter surfaces the raw pg driver message as a 500.
    const res = await owner.inject({ method: 'GET', url: '/v1/audit?before=abc' });
    expect(res.statusCode).toBe(400);
  });

  test('an out-of-range or unknown query parameter is a 400', async () => {
    expect((await owner.inject({ method: 'GET', url: '/v1/audit?limit=0' })).statusCode).toBe(400);
    expect((await owner.inject({ method: 'GET', url: '/v1/audit?limit=201' })).statusCode).toBe(400);
    expect((await owner.inject({ method: 'GET', url: '/v1/audit?nope=1' })).statusCode).toBe(400);
  });

  test('the response carries no secret-bearing field', async () => {
    await appendAuditEvent(pool, {
      workspaceId: owner.workspaceId,
      actorKind: 'system',
      action: 'credential.read_use',
      metadata: { connectorKey: 'telegram' },
    });
    const res = await owner.inject({ method: 'GET', url: '/v1/audit' });
    const raw = res.body.toLowerCase();
    for (const banned of ['secret', 'password', 'token', 'encrypted']) {
      expect(raw, `audit response mentions ${banned}`).not.toContain(banned);
    }
  });
});
