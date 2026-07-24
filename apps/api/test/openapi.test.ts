import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry(), rateLimitPerMinute: 1 });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /v1/openapi.json', () => {
  test('is public, parses, and documents the key paths', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    const doc = JSON.parse(r.body) as { openapi: string; paths: Record<string, unknown>; components: unknown };
    expect(doc.openapi).toBe('3.1.0');
    for (const path of [
      '/v1/executions/{id}/retry',
      '/v1/executions/{id}/cancel',
      '/v1/workflows/{id}/callback',
      '/v1/workflows',
      '/v1/connectors',
    ]) {
      expect(doc.paths[path]).toBeDefined();
    }
  });

  test('is not rate-limited even at a tiny limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});
