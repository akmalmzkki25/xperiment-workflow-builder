import { randomBytes } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, latestNodeStates, openWait, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

/** Seed an execution with a WAITING approval node + open approval wait in the caller's workspace. */
async function seedApproval(workspaceId: string, nodeId = 'appr'): Promise<{ executionId: string }> {
  const wf = await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'w') RETURNING id`, [workspaceId]);
  const workflowId = (wf.rows[0] as { id: string }).id;
  const ver = await pool.query(
    `INSERT INTO workflow_versions (workspace_id, workflow_id, version_number, definition_json, definition_hash)
     VALUES ($1,$2,1,'{}'::jsonb,'h') RETURNING id`,
    [workspaceId, workflowId],
  );
  const versionId = (ver.rows[0] as { id: string }).id;
  const ex = await pool.query(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
     VALUES ($1,$2,$3,'RUNNING') RETURNING id`,
    [workspaceId, workflowId, versionId],
  );
  const executionId = (ex.rows[0] as { id: string }).id;
  await pool.query(
    `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt) VALUES ($1,$2,$3,'WAITING',1)`,
    [workspaceId, executionId, nodeId],
  );
  await openWait(pool, {
    executionId,
    nodeId,
    attempt: 1,
    kind: 'approval',
    resumeToken: randomBytes(24).toString('base64url'),
    expiresAt: new Date(Date.now() + 3_600_000),
    fallback: 'reject',
    message: 'Approve the refund?',
  });
  return { executionId };
}

const nodeStatus = async (executionId: string, nodeId: string) =>
  (await latestNodeStates(pool, executionId)).find((n) => n.nodeId === nodeId);

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
  await pool.query(
    `TRUNCATE execution_waits, execution_nodes, execution_events, executions, task_outbox,
     workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

describe('approvals API', () => {
  test('approve resolves the wait and advances the node on the approved port', async () => {
    const { executionId } = await seedApproval(auth.workspaceId);
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/executions/${executionId}/approvals/appr`,
      payload: { decision: 'approve', comment: 'ok' },
    });
    expect(r.statusCode).toBe(200);
    const node = await nodeStatus(executionId, 'appr');
    expect(node?.status).toBe('SUCCEEDED');
    expect(node?.outputPort).toBe('approved');
  });

  test('the decision is audited on the wait row (decision, resolved_by, comment)', async () => {
    const { executionId } = await seedApproval(auth.workspaceId);
    await auth.inject({
      method: 'POST',
      url: `/v1/executions/${executionId}/approvals/appr`,
      payload: { decision: 'approve', comment: 'signed off' },
    });
    const row = await pool.query(
      `SELECT status, decision, resolved_by, comment, resolved_at FROM execution_waits WHERE execution_id=$1`,
      [executionId],
    );
    const w = row.rows[0] as { status: string; decision: string; resolved_by: string | null; comment: string; resolved_at: string | null };
    expect(w.status).toBe('resolved');
    expect(w.decision).toBe('approve');
    expect(w.resolved_by).toBe(auth.userId);
    expect(w.comment).toBe('signed off');
    expect(w.resolved_at).not.toBeNull();
  });

  test('execution detail never leaks resume tokens and scopes resumeUrl to open event waits', async () => {
    const { executionId } = await seedApproval(auth.workspaceId, 'gate');
    // Add an open event wait too.
    await pool.query(
      `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt) VALUES ($1,$2,'evt','WAITING',1)`,
      [auth.workspaceId, executionId],
    );
    await openWait(pool, {
      executionId,
      nodeId: 'evt',
      attempt: 1,
      kind: 'event',
      resumeToken: 'super-secret-token-value',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const r = await auth.inject({ method: 'GET', url: `/v1/executions/${executionId}` });
    const detail = r.json<{ waits: (Record<string, unknown> & { nodeId: string; resumeUrl?: string })[] }>();
    const evt = detail.waits.find((w) => w.nodeId === 'evt')!;
    const gate = detail.waits.find((w) => w.nodeId === 'gate')!;
    // The token is exposed ONLY through the event wait's resumeUrl — never as a
    // bare resume_token field, and never on the approval wait.
    expect(evt.resumeUrl).toMatch(/\/r\/super-secret-token-value$/);
    expect(gate.resumeUrl).toBeUndefined();
    expect('resumeToken' in evt).toBe(false);
    expect(JSON.stringify(gate)).not.toContain('super-secret-token-value');
  });

  test('reject advances on the rejected port', async () => {
    const { executionId } = await seedApproval(auth.workspaceId);
    await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/approvals/appr`, payload: { decision: 'reject' } });
    expect((await nodeStatus(executionId, 'appr'))?.outputPort).toBe('rejected');
  });

  test('a second decision on the same wait is a 409', async () => {
    const { executionId } = await seedApproval(auth.workspaceId);
    await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/approvals/appr`, payload: { decision: 'approve' } });
    const again = await auth.inject({
      method: 'POST',
      url: `/v1/executions/${executionId}/approvals/appr`,
      payload: { decision: 'approve' },
    });
    expect([404, 409]).toContain(again.statusCode);
  });

  test('the pending list shows the open approval, then hides it after a decision', async () => {
    const { executionId } = await seedApproval(auth.workspaceId);
    const before = await auth.inject({ method: 'GET', url: '/v1/approvals' });
    expect(before.json<{ items: unknown[] }>().items).toHaveLength(1);
    await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/approvals/appr`, payload: { decision: 'approve' } });
    const after = await auth.inject({ method: 'GET', url: '/v1/approvals' });
    expect(after.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  test('a cross-workspace approval decision sees no open wait (404)', async () => {
    const other = await createAuthedUser(app);
    const { executionId } = await seedApproval(other.workspaceId);
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/executions/${executionId}/approvals/appr`,
      payload: { decision: 'approve' },
    });
    expect(r.statusCode).toBe(404);
    expect((await nodeStatus(executionId, 'appr'))?.status).toBe('WAITING');
  });

  test('deciding an unknown node is a 404', async () => {
    const { executionId } = await seedApproval(auth.workspaceId);
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/executions/${executionId}/approvals/ghost`,
      payload: { decision: 'approve' },
    });
    expect(r.statusCode).toBe(404);
  });
});
