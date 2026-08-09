import { createDefaultRegistry } from '@xperiment/connectors';
import { createExecutionWithTrigger, createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

function webhookIr(authMode = 'hmac') {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_hook', name: 'Hook' },
    entrypoints: ['hook'],
    nodes: [
      {
        id: 'hook',
        kind: 'trigger',
        type: 'webhook.trigger',
        operationVersion: '0.1.0',
        parameters: { authMode, idempotencyKeyPath: 'event.id' },
      },
      {
        id: 'echo',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { got: '{{ trigger.body.body.event.id }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
  };
}

function scheduleIr() {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_cron', name: 'Cron' },
    entrypoints: ['tick'],
    nodes: [
      {
        id: 'tick',
        kind: 'trigger',
        type: 'schedule.trigger',
        operationVersion: '0.1.0',
        parameters: { cron: '*/5 * * * *', timezone: 'UTC' },
      },
      {
        id: 'echo',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { at: '{{ trigger.body.scheduledFor }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'tick', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
  };
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({
    pool,
    registry: createDefaultRegistry({ allowPrivateIps: true }),
    gatewayUrl: 'http://gw.test',
  });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows, audit_events CASCADE`,
  );
});

async function publishedWorkflow(definition: unknown): Promise<string> {
  const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } });
  const id = created.json<{ id: string }>().id;
  await auth.inject({
    method: 'PUT',
    url: `/v1/workflows/${id}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition },
  });
  const pub = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
  expect(pub.statusCode).toBe(201);
  return id;
}

describe('trigger secret encryption and reveal audit', () => {
  async function revealRows(): Promise<{ target_id: string | null; metadata: Record<string, unknown> }[]> {
    const r = await pool.query<{ target_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT target_id, metadata FROM audit_events WHERE action = 'trigger_secret.reveal' ORDER BY id`,
    );
    return r.rows;
  }

  test('an activated webhook trigger stores its secret at the envelope version', async () => {
    const id = await publishedWorkflow(webhookIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const row = await pool.query<{ secret_enc_version: number; secret_encrypted: Buffer }>(
      `SELECT secret_enc_version, secret_encrypted FROM workflow_triggers WHERE workflow_id = $1`,
      [id],
    );
    expect(row.rows[0]!.secret_enc_version).toBe(1);
    expect(row.rows[0]!.secret_encrypted[0]).toBe(1); // v1 marker
  });

  test('a trigger with authMode none stores no secret and no version', async () => {
    const id = await publishedWorkflow(webhookIr('none'));
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const row = await pool.query<{ secret_enc_version: number; secret_encrypted: Buffer | null }>(
      `SELECT secret_enc_version, secret_encrypted FROM workflow_triggers WHERE workflow_id = $1`,
      [id],
    );
    expect(row.rows[0]!.secret_encrypted).toBeNull();
    expect(row.rows[0]!.secret_enc_version).toBe(0);
  });

  test('listing triggers with credentials reveals the secret and audits the reveal', async () => {
    const id = await publishedWorkflow(webhookIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    await pool.query(`TRUNCATE audit_events CASCADE`); // isolate the GET from the activate
    const res = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers` });
    expect(res.statusCode).toBe(200);
    const triggers = res.json<{ triggers: { nodeId: string; secret?: string | null }[] }>().triggers;
    const hook = triggers.find((t) => t.nodeId === 'hook')!;
    expect(typeof hook.secret).toBe('string');
    const rows = await revealRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe('hook');
    // The revealed secret must not also be written into the audit row.
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(hook.secret!);
  });

  test('a reader gets no secret and no reveal is audited', async () => {
    const id = await publishedWorkflow(webhookIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const res = await viewer.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers` });
    expect(res.statusCode).toBe(200);
    const triggers = res.json<{ triggers: Record<string, unknown>[] }>().triggers;
    expect(triggers.find((t) => t['nodeId'] === 'hook')).not.toHaveProperty('secret');
    expect(await revealRows()).toHaveLength(0);
  });

  test('the activate response also reveals the secret, and is audited too', async () => {
    // Activate returns url/testUrl/secret for every webhook trigger. Auditing only the
    // GET would leave a hole: activate then read the secret from that response, with no
    // reveal row anywhere.
    const id = await publishedWorkflow(webhookIr());
    const res = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const triggers = res.json<{ triggers: { nodeId: string; secret?: string | null }[] }>().triggers;
    expect(typeof triggers.find((t) => t.nodeId === 'hook')!.secret).toBe('string');
    expect(await revealRows()).toHaveLength(1);
  });

  test('a schedule trigger is never a reveal', async () => {
    const id = await publishedWorkflow(scheduleIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    await pool.query(`TRUNCATE audit_events CASCADE`);
    await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers` });
    expect(await revealRows()).toHaveLength(0);
  });
});

describe('activation', () => {
  test('activate requires a published version', async () => {
    const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'D' } });
    const id = created.json<{ id: string }>().id;
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    expect(r.statusCode).toBe(409);
  });

  test('activate materializes a webhook trigger with urls and secret', async () => {
    const id = await publishedWorkflow(webhookIr());
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      active: boolean;
      triggers: { nodeId: string; type: string; url: string; testUrl: string; secret: string | null }[];
    }>();
    expect(body.active).toBe(true);
    expect(body.triggers).toHaveLength(1);
    const t = body.triggers[0]!;
    expect(t.nodeId).toBe('hook');
    expect(t.url).toMatch(/^http:\/\/gw\.test\/t\/[A-Za-z0-9_-]+$/);
    expect(t.testUrl).toContain('/t/test/');
    expect(t.secret).toBeTruthy(); // hmac mode -> generated secret returned
  });

  test('re-activate preserves the webhook URL; authMode none has no secret', async () => {
    const id = await publishedWorkflow(webhookIr());
    const first = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const url1 = first.json<{ triggers: { url: string }[] }>().triggers[0]!.url;
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/deactivate` });
    const second = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    expect(second.json<{ triggers: { url: string }[] }>().triggers[0]!.url).toBe(url1);

    const id2 = await publishedWorkflow(webhookIr('none'));
    const r2 = await auth.inject({ method: 'POST', url: `/v1/workflows/${id2}/activate` });
    expect(r2.json<{ triggers: { secret: string | null }[] }>().triggers[0]!.secret).toBeNull();
  });

  test('activate computes nextFireAt for schedule triggers', async () => {
    const id = await publishedWorkflow(scheduleIr());
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const t = r.json<{ triggers: { type: string; nextFireAt: string | null; cron: string }[] }>().triggers[0]!;
    expect(t.type).toBe('schedule');
    expect(t.cron).toBe('*/5 * * * *');
    expect(new Date(t.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
  });

  test('deactivate flips flags; list shows triggers either way', async () => {
    const id = await publishedWorkflow(webhookIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const off = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/deactivate` });
    expect(off.json<{ active: boolean }>().active).toBe(false);
    const list = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers` });
    expect(list.json<{ triggers: unknown[] }>().triggers).toHaveLength(1);
  });

  test('samples endpoint returns recent test payloads (404 for unknown node)', async () => {
    const id = await publishedWorkflow(webhookIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const missing = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers/ghost/samples` });
    expect(missing.statusCode).toBe(404);
    const empty = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers/hook/samples` });
    expect(empty.json<{ samples: unknown[] }>().samples).toEqual([]);
  });

  test('a viewer cannot read sample payloads', async () => {
    // A sample IS a node payload: it becomes trigger.body on every run. The same gate
    // gets applied here as on the run timeline, or execution:read becomes a transitive
    // read of whatever a provider posted.
    const id = await publishedWorkflow(webhookIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const res = await viewer.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers/hook/samples` });
    expect(res.statusCode).toBe(403);
  });

  test('a secret-named header in a recorded body is redacted before it is shown', async () => {
    const id = await publishedWorkflow(webhookIr());
    await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const versionRow = await pool.query<{ id: string }>(
      `SELECT active_version_id AS id FROM workflows WHERE id = $1`,
      [id],
    );
    const execution = await createExecutionWithTrigger(pool, {
      workflowId: id,
      versionId: versionRow.rows[0]!.id,
      idempotencyKey: 'redact-me',
      payload: { body: { ok: true }, headers: { 'x-api-key': 'sk-live-should-not-appear' }, query: {} },
      nodeIds: ['hook'],
      executionTimeoutMs: 60_000,
      triggerNodeId: 'hook',
    });
    const executionId = (execution as { execution: { id: string } }).execution.id;
    await pool.query(`UPDATE executions SET mode = 'test' WHERE id = $1`, [executionId]);

    const res = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers/hook/samples` });
    const text = JSON.stringify(res.json());
    expect(text).not.toContain('sk-live-should-not-appear');
    expect(text).toContain('ok');
  });
});
