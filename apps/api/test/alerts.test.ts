import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
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
  await pool.query(`TRUNCATE alert_events, alert_rules CASCADE`);
});

const failureRule = { name: 'high failures', type: 'failure_rate', params: { windowMinutes: 60, threshold: 0.5, minSample: 3 } };

describe('/v1/alerts', () => {
  test('create returns the rule; a webhook rule returns its secret once', async () => {
    const r = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: failureRule });
    expect(r.statusCode).toBe(201);
    expect(r.json<{ secret?: string }>().secret).toBeUndefined();

    const w = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: { ...failureRule, name: 'w', webhookUrl: 'https://example.com/a' } });
    expect(w.statusCode).toBe(201);
    expect(typeof w.json<{ secret: string }>().secret).toBe('string');

    const list = await auth.inject({ method: 'GET', url: '/v1/alerts' });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2);
    expect(list.body).not.toContain('secret'); // secrets never listed
  });

  test('rejects invalid params per type', async () => {
    const bad = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: { name: 'x', type: 'failure_rate', params: { windowMinutes: 60, threshold: 5 } } });
    expect(bad.statusCode).toBe(400); // threshold must be 0..1
    const badMetric = await auth.inject({ method: 'POST', url: '/v1/alerts', payload: { name: 'x', type: 'usage_threshold', params: { windowMinutes: 60, metric: 'bogus', threshold: 1 } } });
    expect(badMetric.statusCode).toBe(400);
  });

  test('update + delete + cross-workspace 404', async () => {
    const created = (await auth.inject({ method: 'POST', url: '/v1/alerts', payload: failureRule })).json<{ id: string }>();
    const upd = await auth.inject({ method: 'PUT', url: `/v1/alerts/${created.id}`, payload: { enabled: false } });
    expect(upd.json<{ enabled: boolean }>().enabled).toBe(false);
    const other = await createAuthedUser(app);
    expect((await other.inject({ method: 'PUT', url: `/v1/alerts/${created.id}`, payload: { enabled: true } })).statusCode).toBe(404);
    expect((await auth.inject({ method: 'DELETE', url: `/v1/alerts/${created.id}` })).statusCode).toBe(204);
  });

  test('creates a usage_threshold rule with a custom cooldown', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/alerts',
      payload: { name: 'tokens', type: 'usage_threshold', params: { windowMinutes: 30, metric: 'ai_tokens', threshold: 1000 }, cooldownMinutes: 15 },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json<{ cooldownMinutes: number; type: string }>().cooldownMinutes).toBe(15);
    expect(r.json<{ type: string }>().type).toBe('usage_threshold');
  });

  test('deleting a missing rule and acking a missing event are 404', async () => {
    const missing = '00000000-0000-0000-0000-0000000000aa';
    expect((await auth.inject({ method: 'DELETE', url: `/v1/alerts/${missing}` })).statusCode).toBe(404);
    expect((await auth.inject({ method: 'POST', url: `/v1/alerts/events/${missing}/ack` })).statusCode).toBe(404);
  });

  test('events accepts a non-numeric limit by falling back to the default', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/alerts/events?limit=abc' });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json<{ items: unknown[] }>().items)).toBe(true);
  });

  test('events list + ack', async () => {
    const rule = (await auth.inject({ method: 'POST', url: '/v1/alerts', payload: failureRule })).json<{ id: string }>();
    await pool.query(`INSERT INTO alert_events (workspace_id, rule_id, fired_at, detail) VALUES ($1,$2,now(),'{}')`, [auth.workspaceId, rule.id]);
    const ev = await auth.inject({ method: 'GET', url: '/v1/alerts/events' });
    expect(ev.json<{ unacknowledged: number; items: { id: string }[] }>().unacknowledged).toBe(1);
    const id = ev.json<{ items: { id: string }[] }>().items[0]!.id;
    expect((await auth.inject({ method: 'POST', url: `/v1/alerts/events/${id}/ack` })).statusCode).toBe(200);
    expect((await auth.inject({ method: 'GET', url: '/v1/alerts/events' })).json<{ unacknowledged: number }>().unacknowledged).toBe(0);
  });
});
