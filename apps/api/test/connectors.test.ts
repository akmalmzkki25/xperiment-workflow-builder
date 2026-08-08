import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

const registry = createDefaultRegistry();

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /v1/connectors', () => {
  test('requires auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/connectors' });
    expect(r.statusCode).toBe(401);
  });

  test('returns full catalog with JSON-Schema params and no internals', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/connectors' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ items: Record<string, unknown>[] }>();
    // The route serves the whole catalog. Asserting against the registry rather than
    // a literal keeps this green as connectors land.
    expect(body.items).toHaveLength(registry.list().length);
    const webhook = body.items.find((i) => i['type'] === 'webhook.trigger');
    expect(webhook).toBeDefined();
    expect((webhook!['paramsJsonSchema'] as { type: string }).type).toBe('object');
    for (const item of body.items) {
      expect(item).not.toHaveProperty('run');
      expect(item).not.toHaveProperty('paramsSchema');
    }
  });
});
