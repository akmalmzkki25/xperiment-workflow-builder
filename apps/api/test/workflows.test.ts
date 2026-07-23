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

async function createAndDraft(): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Lead' } });
  const id = created.json<{ id: string }>().id;
  await app.inject({
    method: 'PUT',
    url: `/v1/workflows/${id}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition: leadCheckIr() },
  });
  return id;
}

describe('workflow routes', () => {
  test('healthz responds ok with request id echo', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/healthz', headers: { 'x-request-id': 'req-1' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-request-id']).toBe('req-1');
    expect(r.json()).toEqual({ status: 'ok' });
  });

  test('create workflow returns 201 and generated x-request-id', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Lead' } });
    expect(r.statusCode).toBe(201);
    expect(r.headers['x-request-id']).toBeTruthy();
    const body = r.json<{ id: string; name: string; draftRevision: number }>();
    expect(body.name).toBe('Lead');
    expect(body.draftRevision).toBe(1);
  });

  test('create workflow with missing name is a 400 problem', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/workflows', payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.json<{ status: number }>().status).toBe(400);
  });

  test('get workflow returns metadata, draft, versions; 404 for unknown', async () => {
    const id = await createAndDraft();
    const r = await app.inject({ method: 'GET', url: `/v1/workflows/${id}` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ draft: { revision: number }; versions: unknown[] }>();
    expect(body.draft.revision).toBe(2);
    expect(body.versions).toEqual([]);
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/workflows/00000000-0000-0000-0000-0000000000aa',
    });
    expect(missing.statusCode).toBe(404);
  });

  test('draft update requires If-Match and detects conflicts', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } });
    const id = created.json<{ id: string }>().id;
    const noHeader = await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${id}/draft`,
      payload: { definition: leadCheckIr() },
    });
    expect(noHeader.statusCode).toBe(428);
    const stale = await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${id}/draft`,
      headers: { 'if-match': '99' },
      payload: { definition: leadCheckIr() },
    });
    expect(stale.statusCode).toBe(412);
    const ok = await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${id}/draft`,
      headers: { 'if-match': '1' },
      payload: { definition: leadCheckIr() },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ revision: number }>().revision).toBe(2);
  });

  test('validate returns structured findings for a broken draft', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } });
    const id = created.json<{ id: string }>().id;
    const broken = leadCheckIr() as { edges: { from: { nodeId: string } }[] };
    broken.edges[0]!.from.nodeId = 'ghost';
    await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${id}/draft`,
      headers: { 'if-match': '1' },
      payload: { definition: broken },
    });
    const r = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/validate` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ valid: boolean; findings: { code: string }[] }>();
    expect(body.valid).toBe(false);
    expect(body.findings.some((f) => f.code === 'unknown_edge_node')).toBe(true);
  });

  test('publish freezes a version on valid draft; 422 on invalid', async () => {
    const id = await createAndDraft();
    const r = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ versionNumber: number; definitionHash: string }>();
    expect(body.versionNumber).toBe(1);
    expect(body.definitionHash).toMatch(/^[a-f0-9]{64}$/);

    const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Bad' } });
    const badId = created.json<{ id: string }>().id;
    const bad = await app.inject({ method: 'POST', url: `/v1/workflows/${badId}/publish` });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ errors: unknown[] }>().errors.length).toBeGreaterThan(0);
  });

  test('list workflows paginates', async () => {
    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: `wf-${i}` } });
    }
    const r = await app.inject({ method: 'GET', url: '/v1/workflows?limit=2' });
    const body = r.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
  });
});
