import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';
import { leadCheckIr } from './fixtures.js';

let pool: Pool;
let app: FastifyInstance;
let alice: AuthedUser;
let bob: AuthedUser;
let aliceWorkflowId: string;
let aliceConnectionId: string;
let aliceExecutionId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
  alice = await createAuthedUser(app);
  bob = await createAuthedUser(app);

  const wf = await alice.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Alice wf' } });
  aliceWorkflowId = wf.json<{ id: string }>().id;
  await alice.inject({
    method: 'PUT',
    url: `/v1/workflows/${aliceWorkflowId}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition: leadCheckIr() },
  });
  await alice.inject({ method: 'POST', url: `/v1/workflows/${aliceWorkflowId}/publish` });
  const exec = await alice.inject({ method: 'POST', url: `/v1/workflows/${aliceWorkflowId}/execute`, payload: {} });
  aliceExecutionId = exec.json<{ executionId: string }>().executionId;
  const conn = await alice.inject({
    method: 'POST',
    url: '/v1/connections',
    payload: { connectorKey: 'telegram', name: 'Alice bot', payload: { botToken: 'alice-secret' } },
  });
  aliceConnectionId = conn.json<{ id: string }>().id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('cross-tenant isolation (IDOR matrix)', () => {
  test('bob cannot see or touch alice workflows', async () => {
    expect((await bob.inject({ method: 'GET', url: `/v1/workflows/${aliceWorkflowId}` })).statusCode).toBe(404);
    expect(
      (
        await bob.inject({
          method: 'PUT',
          url: `/v1/workflows/${aliceWorkflowId}/draft`,
          headers: { 'if-match': '2' },
          payload: { definition: {} },
        })
      ).statusCode,
    ).toBe(404);
    expect((await bob.inject({ method: 'POST', url: `/v1/workflows/${aliceWorkflowId}/publish` })).statusCode).toBe(404);
    expect((await bob.inject({ method: 'POST', url: `/v1/workflows/${aliceWorkflowId}/execute`, payload: {} })).statusCode).toBe(404);
    expect((await bob.inject({ method: 'POST', url: `/v1/workflows/${aliceWorkflowId}/activate` })).statusCode).toBe(404);
    expect((await bob.inject({ method: 'GET', url: `/v1/workflows/${aliceWorkflowId}/triggers` })).statusCode).toBe(404);
    const list = await bob.inject({ method: 'GET', url: '/v1/workflows' });
    expect(list.json<{ items: { id: string }[] }>().items.every((w) => w.id !== aliceWorkflowId)).toBe(true);
  });

  test('bob cannot see alice executions or connections', async () => {
    expect((await bob.inject({ method: 'GET', url: `/v1/executions/${aliceExecutionId}` })).statusCode).toBe(404);
    const executions = await bob.inject({ method: 'GET', url: '/v1/executions' });
    expect(executions.json<{ items: unknown[] }>().items).toHaveLength(0);
    const connections = await bob.inject({ method: 'GET', url: '/v1/connections' });
    expect(connections.json<{ items: unknown[] }>().items).toHaveLength(0);
    expect((await bob.inject({ method: 'DELETE', url: `/v1/connections/${aliceConnectionId}` })).statusCode).toBe(404);
    expect((await bob.inject({ method: 'POST', url: `/v1/connections/${aliceConnectionId}/test` })).statusCode).toBe(404);
  });

  test('bob api key stays inside bob workspace', async () => {
    const created = await bob.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'bk' } });
    const key = created.json<{ key: string }>().key;
    const viaKey = await app.inject({
      method: 'GET',
      url: `/v1/workflows/${aliceWorkflowId}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(viaKey.statusCode).toBe(404);
  });
});
