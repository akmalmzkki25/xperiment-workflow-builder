import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { registerRateLimit } from '../src/rateLimit/plugin.js';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry(), rateLimitPerMinute: 3 });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('rate limiting', () => {
  test('advertises the limit and 429s past it', async () => {
    // createAuthedUser already spent 1 request (register). Limit is 3 per workspace.
    const r1 = await auth.inject({ method: 'GET', url: '/v1/workflows' });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['x-ratelimit-limit']).toBe('3');
    expect(Number(r1.headers['x-ratelimit-remaining'])).toBeLessThan(3);

    // Drive it over the limit.
    let last = r1;
    for (let i = 0; i < 5; i += 1) last = await auth.inject({ method: 'GET', url: '/v1/workflows' });
    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
  });

  test('healthz and openapi are never limited', async () => {
    for (let i = 0; i < 10; i += 1) {
      const h = await app.inject({ method: 'GET', url: '/v1/healthz' });
      expect(h.statusCode).toBe(200);
      expect(h.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});

describe('rate-limit window reset (injectable clock)', () => {
  test('a 429ed key recovers once the window elapses', async () => {
    let clock = 1_000_000;
    const bare = Fastify();
    registerRateLimit(bare, { perMinute: 2, now: () => clock });
    bare.get('/v1/ping', async () => ({ ok: true }));
    await bare.ready();
    const hit = () => bare.inject({ method: 'GET', url: '/v1/ping' });

    const a = await hit();
    expect(a.statusCode).toBe(200);
    expect(a.headers['x-ratelimit-remaining']).toBe('1');
    expect(a.headers['x-ratelimit-reset']).toBe(String(Math.ceil((clock + 60_000) / 1000)));
    expect((await hit()).headers['x-ratelimit-remaining']).toBe('0'); // count 2
    expect((await hit()).statusCode).toBe(429); // count 3 — over the limit

    clock += 60_000; // cross the window boundary → bucket resets
    const recovered = await hit();
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers['x-ratelimit-remaining']).toBe('1');

    await bare.close();
  });
});
