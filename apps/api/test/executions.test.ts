import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { leadCheckIr } from './fixtures.js';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

async function publishedWorkflow(): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Lead' } });
  const id = created.json<{ id: string }>().id;
  await app.inject({
    method: 'PUT',
    url: `/v1/workflows/${id}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition: leadCheckIr() },
  });
  await app.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
  return id;
}

describe('execute and inspect', () => {
  test('execute creates a CREATED execution with PENDING nodes and outbox rows', async () => {
    const id = await publishedWorkflow();
    const r = await app.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      payload: { name: 'Budi', total: 150 },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ executionId: string; status: string; created: boolean }>();
    expect(body.status).toBe('CREATED');
    expect(body.created).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/v1/executions/${body.executionId}` });
    const d = detail.json<{ execution: { status: string }; nodes: { status: string }[]; events: unknown[] }>();
    expect(d.execution.status).toBe('CREATED');
    expect(d.nodes).toHaveLength(4); // t, branch, notify, archive
    expect(d.nodes.every((n) => n.status === 'PENDING')).toBe(true);

    const outbox = await pool.query(`SELECT event_type FROM task_outbox WHERE published_at IS NULL`);
    const types = (outbox.rows as { event_type: string }[]).map((x) => x.event_type).sort();
    expect(types).toEqual(['execution.requested', 'execution.watchdog']);
  });

  test('duplicate Idempotency-Key returns 200 with the same execution', async () => {
    const id = await publishedWorkflow();
    const first = await app.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      headers: { 'idempotency-key': 'dup-1' },
      payload: { name: 'Budi' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      headers: { 'idempotency-key': 'dup-1' },
      payload: { name: 'Budi' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ executionId: string }>().executionId).toBe(
      first.json<{ executionId: string }>().executionId,
    );
  });

  test('execute without a published version is a 409 problem', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } });
    const id = created.json<{ id: string }>().id;
    const r = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/execute`, payload: {} });
    expect(r.statusCode).toBe(409);
  });

  test('executions list filters by workflowId', async () => {
    const id = await publishedWorkflow();
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: `/v1/workflows/${id}/execute`,
        headers: { 'idempotency-key': `k${i}` },
        payload: {},
      });
    }
    const r = await app.inject({ method: 'GET', url: `/v1/executions?workflowId=${id}&limit=2` });
    const body = r.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
  });

  test('unknown execution is 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/executions/00000000-0000-0000-0000-0000000000bb' });
    expect(r.statusCode).toBe(404);
  });

  test('execute on unknown workflow is 404', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/workflows/00000000-0000-0000-0000-0000000000cc/execute',
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });

  test('executions list rejects invalid query and follows cursors', async () => {
    const bad = await app.inject({ method: 'GET', url: '/v1/executions?limit=0' });
    expect(bad.statusCode).toBe(400);
    const id = await publishedWorkflow();
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: `/v1/workflows/${id}/execute`,
        headers: { 'idempotency-key': `cur${i}` },
        payload: {},
      });
    }
    const all = await app.inject({ method: 'GET', url: '/v1/executions?limit=2' });
    const page1 = all.json<{ items: unknown[]; nextCursor: string }>();
    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/executions?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
    });
    expect(page2.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  test('workflows list rejects invalid query', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/workflows?limit=0' });
    expect(r.statusCode).toBe(400);
  });
});
