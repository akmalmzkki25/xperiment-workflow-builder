import { createDefaultRegistry } from '@xperiment/connectors';
import {
  createPool,
  createSecretVault,
  createWorkspaceKeyring,
  deriveLegacyKey,
  getWorkflowCallback,
  localKeyProvider,
  runMigrations,
  type SecretVault,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;
const triggerKey = deriveLegacyKey('xperiment-dev-trigger-secret-change-me');
let triggerVault: SecretVault;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  // The test owns the vault so the round-trip assertion is deterministic rather than
  // depending on the server's env-derived default.
  triggerVault = createSecretVault({
    keyring: createWorkspaceKeyring({ pool, provider: localKeyProvider('callback-test-master') }),
    legacyKey: triggerKey,
  });
  app = buildServer({ pool, registry: createDefaultRegistry(), triggerKey, triggerVault });
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
    // Stored under envelope encryption, scoped to the workflow's workspace, and it
    // decrypts back to exactly what was shown once.
    expect(stored!.encVersion).toBe(1);
    expect(stored!.workspaceId).toBe(auth.workspaceId);
    expect(stored!.secretEncrypted.toString('utf8')).not.toContain(secret);
    expect(
      await triggerVault.decrypt(stored!.workspaceId, {
        blob: stored!.secretEncrypted,
        encVersion: stored!.encVersion,
      }),
    ).toBe(secret);
  });

  test('a legacy callback secret still decrypts through the vault', async () => {
    // The mixed state the backfill depends on: a v0 row written before this slice must
    // stay readable while v1 rows are being created alongside it.
    const id = await newWorkflow();
    await auth.inject({ method: 'PUT', url: `/v1/workflows/${id}/callback`, payload: { url: 'https://x.co/h' } });
    const { encryptSecret } = await import('@xperiment/db');
    await pool.query(
      `UPDATE workflows SET completion_webhook_secret_encrypted = $1, completion_webhook_enc_version = 0 WHERE id = $2`,
      [encryptSecret('legacy-cb-secret', triggerKey), id],
    );
    const stored = await getWorkflowCallback(pool, id);
    expect(stored!.encVersion).toBe(0);
    expect(
      await triggerVault.decrypt(stored!.workspaceId, {
        blob: stored!.secretEncrypted,
        encVersion: stored!.encVersion,
      }),
    ).toBe('legacy-cb-secret');
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
