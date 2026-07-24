import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, deriveTriggerKey, decryptSecret, getWorkflowCallback, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;
const triggerKey = deriveTriggerKey('xperiment-dev-trigger-secret-change-me');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry(), triggerKey });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE workflows, workflow_drafts, workflow_versions CASCADE`);
});

async function newWorkflow(): Promise<string> {
  const r = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'W' } });
  return r.json<{ id: string }>().id;
}

describe('workflow completion callback', () => {
  test('PUT stores an encrypted secret and returns it once', async () => {
    const id = await newWorkflow();
    const r = await auth.inject({
      method: 'PUT',
      url: `/v1/workflows/${id}/callback`,
      payload: { url: 'https://example.com/hook' },
    });
    expect(r.statusCode).toBe(200);
    const { url, secret } = r.json<{ url: string; secret: string }>();
    expect(url).toBe('https://example.com/hook');
    expect(secret).toBeTruthy();
    const stored = await getWorkflowCallback(pool, id);
    expect(stored?.url).toBe('https://example.com/hook');
    // The secret is stored encrypted, not plaintext, and decrypts back to what was shown once.
    expect(stored!.secretEncrypted.toString('utf8')).not.toContain(secret);
    expect(decryptSecret(stored!.secretEncrypted, triggerKey)).toBe(secret);
  });

  test('rejects a non-URL and clears on DELETE', async () => {
    const id = await newWorkflow();
    const bad = await auth.inject({ method: 'PUT', url: `/v1/workflows/${id}/callback`, payload: { url: 'not-a-url' } });
    expect(bad.statusCode).toBe(400);
    await auth.inject({ method: 'PUT', url: `/v1/workflows/${id}/callback`, payload: { url: 'https://example.com/h' } });
    const del = await auth.inject({ method: 'DELETE', url: `/v1/workflows/${id}/callback` });
    expect(del.statusCode).toBe(204);
    expect(await getWorkflowCallback(pool, id)).toBeNull();
  });

  test('cross-workspace callback set is 404', async () => {
    const id = await newWorkflow();
    const other = await createAuthedUser(app);
    const r = await other.inject({ method: 'PUT', url: `/v1/workflows/${id}/callback`, payload: { url: 'https://x.co/h' } });
    expect(r.statusCode).toBe(404);
  });
});
