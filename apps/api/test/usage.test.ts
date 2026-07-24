import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, insertUsageEvents, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE usage_events`);
});

describe('GET /v1/usage', () => {
  test('returns tenant-scoped totals within the default period', async () => {
    const now = new Date();
    await insertUsageEvents(pool, [
      { workspaceId: auth.workspaceId, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: now },
      { workspaceId: auth.workspaceId, metric: 'node', quantity: 2, occurredAt: now },
    ]);
    const r = await auth.inject({ method: 'GET', url: '/v1/usage' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ totals: { executions: number; nodes: number } }>();
    expect(body.totals.executions).toBe(1);
    expect(body.totals.nodes).toBe(2);
  });

  test('excludes another workspace usage', async () => {
    const other = await createAuthedUser(app);
    await insertUsageEvents(pool, [
      { workspaceId: other.workspaceId, metric: 'execution', quantity: 5, metadata: { status: 'SUCCEEDED' }, occurredAt: new Date() },
    ]);
    const r = await auth.inject({ method: 'GET', url: '/v1/usage' });
    expect(r.json<{ totals: { executions: number } }>().totals.executions).toBe(0);
  });

  test('rejects an inverted range', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/usage?from=2026-07-10&to=2026-07-01' });
    expect(r.statusCode).toBe(400);
  });

  test('the default period excludes usage before the current UTC month', async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await insertUsageEvents(pool, [
      { workspaceId: auth.workspaceId, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: lastMonth },
      { workspaceId: auth.workspaceId, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: now },
    ]);
    const r = await auth.inject({ method: 'GET', url: '/v1/usage' });
    expect(r.json<{ totals: { executions: number } }>().totals.executions).toBe(1); // only this month's row
  });

  test('a custom from/to filters rows to the window', async () => {
    await insertUsageEvents(pool, [
      { workspaceId: auth.workspaceId, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: new Date('2026-03-15T00:00:00Z') },
      { workspaceId: auth.workspaceId, metric: 'execution', quantity: 1, metadata: { status: 'SUCCEEDED' }, occurredAt: new Date('2026-05-15T00:00:00Z') },
    ]);
    const r = await auth.inject({ method: 'GET', url: '/v1/usage?from=2026-03-01&to=2026-04-01' });
    expect(r.json<{ totals: { executions: number } }>().totals.executions).toBe(1); // only the March row
  });
});
