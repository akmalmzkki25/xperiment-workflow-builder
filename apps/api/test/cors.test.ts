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
  app = buildServer({ pool, registry: createDefaultRegistry() });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('CORS for the browser client', () => {
  test('answers preflight with allowed methods and headers', async () => {
    const r = await app.inject({
      method: 'OPTIONS',
      url: '/v1/workflows',
      headers: {
        origin: 'http://localhost:3005',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,if-match,x-xperiment-workspace',
      },
    });
    expect([200, 204]).toContain(r.statusCode);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3005');
    expect(String(r.headers['access-control-allow-headers'])).toMatch(/if-match/i);
    expect(String(r.headers['access-control-allow-methods'])).toMatch(/PUT/);
  });

  test('reflects origin on simple requests', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/healthz',
      headers: { origin: 'http://localhost:3005' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3005');
  });
});
