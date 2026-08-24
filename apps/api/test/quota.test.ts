import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import { PLAN_CATALOG } from '@xperiment/plans';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser } from './authHelpers.js';

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

const setLimit = (ws: string, patch: Record<string, number | null>) =>
  pool.query(`UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`, [ws, JSON.stringify(patch)]);

describe('GET /v1/plan', () => {
  test('reports the plan, limits, usage and one line per limit', async () => {
    const user = await createAuthedUser(app);
    const r = await user.inject({ method: 'GET', url: '/v1/plan' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ planCode: string; limits: Record<string, unknown>; lines: { metric: string }[] }>();
    expect(body.planCode).toBe('free');
    expect(body.limits).toEqual(PLAN_CATALOG.free);
    expect(body.lines).toHaveLength(4);
  });

  test('a viewer cannot read the plan', async () => {
    const owner = await createAuthedUser(app);
    const viewer = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    expect((await viewer.inject({ method: 'GET', url: '/v1/plan' })).statusCode).toBe(403);
  });

  test('a billing member can read and change the plan', async () => {
    const owner = await createAuthedUser(app);
    const billing = await addMemberWithRole(app, pool, owner.workspaceId, 'billing');
    expect((await billing.inject({ method: 'GET', url: '/v1/plan' })).statusCode).toBe(200);
    const put = await billing.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'team' } });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ planCode: string }>().planCode).toBe('team');
  });
});

describe('PUT /v1/plan', () => {
  test('rejects an unknown plan code', async () => {
    const user = await createAuthedUser(app);
    expect((await user.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'gold' } })).statusCode).toBe(400);
  });

  test('toggles overage', async () => {
    const user = await createAuthedUser(app);
    const r = await user.inject({ method: 'PUT', url: '/v1/plan', payload: { allowOverage: true } });
    expect(r.json<{ allowOverage: boolean }>().allowOverage).toBe(true);
  });

  test('refuses a downgrade the workspace already exceeds', async () => {
    const user = await createAuthedUser(app);
    // free allows 2 members; add two more so team→free would strand it.
    await addMemberWithRole(app, pool, user.workspaceId, 'viewer');
    await addMemberWithRole(app, pool, user.workspaceId, 'viewer');
    await user.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'team' } });
    const down = await user.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'free' } });
    expect(down.statusCode).toBe(409);
    expect(down.json<{ detail: string }>().detail).toContain('members');
  });
});

describe('stock limits', () => {
  test('activating past the active-workflow cap is refused with 402', async () => {
    const user = await createAuthedUser(app);
    await setLimit(user.workspaceId, { activeWorkflows: 0 });
    const wf = (await user.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'cap' } })).json<{
      id: string;
    }>();
    const r = await user.inject({ method: 'POST', url: `/v1/workflows/${wf.id}/activate` });
    expect(r.statusCode).toBe(402);
    expect(r.json<{ detail: string }>().detail).toContain('activeWorkflows');
  });

  test('inviting past the member cap is refused with 402', async () => {
    const user = await createAuthedUser(app);
    await setLimit(user.workspaceId, { members: 1 });
    const r = await user.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'viewer' } });
    expect(r.statusCode).toBe(402);
    expect(r.json<{ detail: string }>().detail).toContain('members');
  });

  test('invites minted under the cap cannot all be redeemed past it', async () => {
    const owner = await createAuthedUser(app);
    await setLimit(owner.workspaceId, { members: 2 });
    // Issuing is free and unbounded, so three invites are all accepted at issue time.
    const tokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await owner.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'viewer' } });
      expect(r.statusCode).toBe(201);
      tokens.push(r.json<{ token: string }>().token);
    }
    // Redeeming is what consumes a seat: the second joiner takes the workspace to the
    // cap of 2, and the third must be refused rather than silently exceeding it.
    const outcomes: number[] = [];
    for (const token of tokens) {
      const joiner = await createAuthedUser(app);
      const r = await joiner.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token } });
      outcomes.push(r.statusCode);
    }
    expect(outcomes).toEqual([200, 402, 402]);
    const seats = await pool.query(`SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1`, [
      owner.workspaceId,
    ]);
    expect((seats.rows[0] as { c: number }).c).toBe(2);
  });

  test('an agent turn past the token cap is refused with 402, before the stream commits', async () => {
    const user = await createAuthedUser(app);
    await setLimit(user.workspaceId, { aiTokensPerMonth: 1 });
    await pool.query(
      // The WIB month, matching how billing periods are keyed since 0022. A UTC key
      // silently misses on the first of a month between midnight and 07:00 WIB.
      `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')::date, 'ai_tokens', 10)
       ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = 10`,
      [user.workspaceId],
    );
    const conv = await user.inject({ method: 'POST', url: '/v1/agent/conversations', payload: {} });
    const id = conv.json<{ conversationId: string }>().conversationId;
    const r = await user.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'hi' },
    });
    // A quota refusal has to be a problem document, which is only possible before the
    // hijack — once text/event-stream is on the wire there is no way to send one.
    expect(r.statusCode).toBe(402);
    expect(r.headers['content-type']).toContain('problem+json');
  });
});

describe('managed alert rules', () => {
  test('the managed quota rule cannot be deleted but can be disabled', async () => {
    const user = await createAuthedUser(app);
    const rules = (await user.inject({ method: 'GET', url: '/v1/alerts' })).json<{
      items: { id: string; managed: boolean }[];
    }>().items;
    const managed = rules.find((r) => r.managed)!;
    expect(managed).toBeTruthy();
    expect((await user.inject({ method: 'DELETE', url: `/v1/alerts/${managed.id}` })).statusCode).toBe(409);
    const off = await user.inject({ method: 'PUT', url: `/v1/alerts/${managed.id}`, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
  });
});
