import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';
import { leadCheckIr } from './fixtures.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
  auth = await createAuthedUser(app);
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
  const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Lead' } });
  const id = created.json<{ id: string }>().id;
  await auth.inject({
    method: 'PUT',
    url: `/v1/workflows/${id}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition: leadCheckIr() },
  });
  await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
  return id;
}

describe('node payloads on the detail response', () => {
  /** Runs a node to SUCCEEDED with a payload carrying a secret-shaped key. */
  async function executionWithPayload(): Promise<string> {
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: { name: 'Budi' } });
    const executionId = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `UPDATE execution_nodes SET status = 'SUCCEEDED', input_json = $2, output_json = $3
       WHERE execution_id = $1 AND node_id = 't'`,
      [
        executionId,
        JSON.stringify({ url: 'https://api.test/v1', headers: { authorization: 'Bearer sk-live-999' } }),
        JSON.stringify({ status: 200, body: { ok: true } }),
      ],
    );
    return executionId;
  }

  test('a member who can run sees the recorded input and output', async () => {
    const id = await executionWithPayload();
    const d = await auth.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const body = d.json<{ payloadsVisible: boolean; nodes: { nodeId: string; outputJson?: unknown }[] }>();
    expect(body.payloadsVisible).toBe(true);
    const node = body.nodes.find((n) => n.nodeId === 't')!;
    expect(node.outputJson).toEqual({ status: 200, body: { ok: true } });
  });

  test('a secret-named parameter key is redacted on the way out', async () => {
    const id = await executionWithPayload();
    const d = await auth.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const node = d
      .json<{ nodes: { nodeId: string; inputJson?: { headers?: { authorization?: string }; url?: string } }[] }>()
      .nodes.find((n) => n.nodeId === 't')!;
    expect(node.inputJson?.headers?.authorization).toBe('[redacted]');
    // Only the credential-shaped key, not the whole object.
    expect(node.inputJson?.url).toBe('https://api.test/v1');
    expect(JSON.stringify(d.json())).not.toContain('sk-live-999');
  });

  test('a viewer gets payloadsVisible false and no payload keys at all', async () => {
    // A viewer is a read-only observer. Handing it payloads would turn execution:read
    // into a transitive read of anything an author typed into a parameter.
    const id = await executionWithPayload();
    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const d = await viewer.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(d.statusCode).toBe(200);
    const body = d.json<{ payloadsVisible: boolean; nodes: Record<string, unknown>[] }>();
    expect(body.payloadsVisible).toBe(false);
    for (const node of body.nodes) {
      expect(Object.keys(node)).not.toContain('inputJson');
      expect(Object.keys(node)).not.toContain('outputJson');
    }
  });

  test('an operator can see payloads, since it may start the run', async () => {
    const id = await executionWithPayload();
    const operator = await addMemberWithRole(app, pool, auth.workspaceId, 'operator');
    const d = await operator.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(d.json<{ payloadsVisible: boolean }>().payloadsVisible).toBe(true);
  });

  test('a viewer never receives a resume URL', async () => {
    // POST /r/:resumeToken carries NO auth, so the URL IS the credential — anyone
    // holding it can drive the run and write that node's output. A viewer is denied
    // execution:run precisely so it cannot do that.
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: {} });
    const id = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `INSERT INTO execution_waits (workspace_id, execution_id, node_id, attempt, kind, status, resume_token)
       VALUES ($3, $1, 't', 1, 'event', 'open', $2)`,
      [id, 'resume-token-secret-abc', auth.workspaceId],
    );

    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const asViewer = await viewer.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(JSON.stringify(asViewer.json())).not.toContain('resume-token-secret-abc');
    for (const w of asViewer.json<{ waits: Record<string, unknown>[] }>().waits) {
      expect(Object.keys(w)).not.toContain('resumeUrl');
    }

    // An operator still gets it — the capability is gated, not removed.
    const asOwner = await auth.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const wait = asOwner.json<{ waits: { resumeUrl?: string }[] }>().waits.find((w) => w.resumeUrl);
    expect(wait?.resumeUrl).toContain('resume-token-secret-abc');
  });

  test('revealing a resume URL is audited', async () => {
    // The trigger-secret route audits every reveal on the grounds that handing out a
    // secret transfers a capability. This one transfers the same kind.
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: {} });
    const id = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `INSERT INTO execution_waits (workspace_id, execution_id, node_id, attempt, kind, status, resume_token)
       VALUES ($3, $1, 't', 1, 'event', 'open', $2)`,
      [id, 'audited-token-xyz', auth.workspaceId],
    );
    await auth.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const audit = await pool.query(
      `SELECT action, target_id FROM audit_events WHERE action = 'execution_resume.reveal' AND target_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  test('an error payload is redacted for every role, not just for payload readers', async () => {
    // errorJson goes to everyone: an http.request failure carries the provider's full
    // response body, and an SSRF refusal carries the raw URL with its query string.
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: {} });
    const id = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `UPDATE execution_nodes SET status = 'FAILED', error_json = $2 WHERE execution_id = $1 AND node_id = 't'`,
      [id, JSON.stringify({ code: 'http_error', details: { body: { access_token: 'leaked-abc-123' } } })],
    );
    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const d = await viewer.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(JSON.stringify(d.json())).not.toContain('leaked-abc-123');
  });
});

describe('execute and inspect', () => {
  test('execute creates a CREATED execution with PENDING nodes and outbox rows', async () => {
    const id = await publishedWorkflow();
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      payload: { name: 'Budi', total: 150 },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ executionId: string; status: string; created: boolean }>();
    expect(body.status).toBe('CREATED');
    expect(body.created).toBe(true);

    const detail = await auth.inject({ method: 'GET', url: `/v1/executions/${body.executionId}` });
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
    const first = await auth.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      headers: { 'idempotency-key': 'dup-1' },
      payload: { name: 'Budi' },
    });
    const second = await auth.inject({
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
    const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } });
    const id = created.json<{ id: string }>().id;
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/execute`, payload: {} });
    expect(r.statusCode).toBe(409);
  });

  test('executions list filters by workflowId', async () => {
    const id = await publishedWorkflow();
    for (let i = 0; i < 3; i += 1) {
      await auth.inject({
        method: 'POST',
        url: `/v1/workflows/${id}/execute`,
        headers: { 'idempotency-key': `k${i}` },
        payload: {},
      });
    }
    const r = await auth.inject({ method: 'GET', url: `/v1/executions?workflowId=${id}&limit=2` });
    const body = r.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
  });

  test('unknown execution is 404', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/executions/00000000-0000-0000-0000-0000000000bb' });
    expect(r.statusCode).toBe(404);
  });

  test('execute on unknown workflow is 404', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/workflows/00000000-0000-0000-0000-0000000000cc/execute',
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });

  test('executions list rejects invalid query and follows cursors', async () => {
    const bad = await auth.inject({ method: 'GET', url: '/v1/executions?limit=0' });
    expect(bad.statusCode).toBe(400);
    const id = await publishedWorkflow();
    for (let i = 0; i < 3; i += 1) {
      await auth.inject({
        method: 'POST',
        url: `/v1/workflows/${id}/execute`,
        headers: { 'idempotency-key': `cur${i}` },
        payload: {},
      });
    }
    const all = await auth.inject({ method: 'GET', url: '/v1/executions?limit=2' });
    const page1 = all.json<{ items: unknown[]; nextCursor: string }>();
    const page2 = await auth.inject({
      method: 'GET',
      url: `/v1/executions?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
    });
    expect(page2.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  test('workflows list rejects invalid query', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/workflows?limit=0' });
    expect(r.statusCode).toBe(400);
  });
});
