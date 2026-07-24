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

const ir = (transformOk: boolean) => ({
  schemaVersion: '0.1',
  workflow: { id: 'wf', name: 'W' },
  entrypoints: ['t'],
  nodes: [
    { id: 't', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'none' } },
    { id: 'a', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: transformOk } } },
  ],
  edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'a', port: 'input' } }],
});

async function publish(id: string, definition: unknown, revision: number): Promise<void> {
  await auth.inject({ method: 'PUT', url: `/v1/workflows/${id}/draft`, payload: { definition }, headers: { 'if-match': String(revision) } });
  const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
  expect(r.statusCode).toBeLessThan(300);
}

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

describe('version diff + rollback', () => {
  test('diffs two versions and a draft against a version, then rolls back', async () => {
    const wf = (await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'V' } })).json<{ id: string; draftRevision: number }>();
    const id = wf.id;
    await publish(id, ir(true), wf.draftRevision); // v1
    const detail1 = (await auth.inject({ method: 'GET', url: `/v1/workflows/${id}` })).json<{ draftRevision: number; versions: { id: string; versionNumber: number }[] }>();
    const v1 = detail1.versions[0]!;
    await publish(id, ir(false), detail1.draftRevision); // v2 (transform param changed)
    const detail2 = (await auth.inject({ method: 'GET', url: `/v1/workflows/${id}` })).json<{ draftRevision: number; versions: { id: string; versionNumber: number }[] }>();
    const v2 = detail2.versions.find((v) => v.versionNumber === 2)!;

    const diff = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/diff?from=${v1.id}&to=${v2.id}` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json<{ diff: { nodes: { modified: { nodeId: string }[] } } }>().diff.nodes.modified).toEqual([{ nodeId: 'a', changedFields: ['parameters'] }]);

    const draftDiff = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/diff?from=draft&to=${v1.id}` });
    expect(draftDiff.statusCode).toBe(200);
    expect(draftDiff.json<{ diff: { changed: boolean } }>().diff.changed).toBe(true);

    const rb = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/versions/${v1.id}/rollback` });
    expect(rb.statusCode).toBe(201);
    expect(rb.json<{ versionNumber: number; rolledBackFrom: number }>().versionNumber).toBe(3);
    expect(rb.json<{ rolledBackFrom: number }>().rolledBackFrom).toBe(1);
    const detail3 = (await auth.inject({ method: 'GET', url: `/v1/workflows/${id}` })).json<{ versions: { id: string; versionNumber: number }[] }>();
    const v3 = detail3.versions.find((v) => v.versionNumber === 3)!;
    const rbDiff = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/diff?from=${v1.id}&to=${v3.id}` });
    expect(rbDiff.json<{ diff: { changed: boolean } }>().diff.changed).toBe(false);
  });

  test('missing from/to is 400; rejects a foreign version ref; no_draft is 400', async () => {
    const wfA = (await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'A' } })).json<{ id: string; draftRevision: number }>();
    await publish(wfA.id, ir(true), wfA.draftRevision);
    const vA = (await auth.inject({ method: 'GET', url: `/v1/workflows/${wfA.id}` })).json<{ versions: { id: string }[] }>().versions[0]!;

    const wfB = (await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'B' } })).json<{ id: string; draftRevision: number }>();
    await publish(wfB.id, ir(true), wfB.draftRevision);

    expect((await auth.inject({ method: 'GET', url: `/v1/workflows/${wfB.id}/diff` })).statusCode).toBe(400); // no from/to
    expect((await auth.inject({ method: 'GET', url: `/v1/workflows/${wfB.id}/diff?from=${vA.id}&to=${vA.id}` })).statusCode).toBe(400); // foreign version
    expect((await auth.inject({ method: 'POST', url: `/v1/workflows/${wfB.id}/versions/${vA.id}/rollback` })).statusCode).toBe(404); // foreign rollback

    await pool.query(`DELETE FROM workflow_drafts WHERE workflow_id = $1`, [wfB.id]);
    expect((await auth.inject({ method: 'GET', url: `/v1/workflows/${wfB.id}/diff?from=draft&to=draft` })).statusCode).toBe(400); // no_draft
  });

  test('cross-workspace diff is 404', async () => {
    const other = await createAuthedUser(app);
    const wf = (await other.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } })).json<{ id: string; draftRevision: number }>();
    await other.inject({ method: 'PUT', url: `/v1/workflows/${wf.id}/draft`, payload: { definition: ir(true) }, headers: { 'if-match': String(wf.draftRevision) } });
    await other.inject({ method: 'POST', url: `/v1/workflows/${wf.id}/publish` });
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${wf.id}/diff?from=draft&to=draft` });
    expect(r.statusCode).toBe(404); // not auth's workspace
  });
});
