import { randomBytes, randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import {
  createExecutionWithTrigger,
  createPool,
  getTriggerPayload,
  latestNodeStates,
  openWait,
  runMigrations,
  waitsForExecution,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

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
    `TRUNCATE usage_events, execution_waits, execution_nodes, execution_events, executions, task_outbox,
     workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

const IR = {
  schemaVersion: '0.1',
  workflow: { id: 'wf', name: 'w' },
  entrypoints: ['t'],
  nodes: [{ id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} }],
  edges: [],
};

async function seedWorkflowVersion(workspaceId: string): Promise<{ workflowId: string; versionId: string }> {
  const wf = await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'w') RETURNING id`, [workspaceId]);
  const workflowId = (wf.rows[0] as { id: string }).id;
  const ver = await pool.query(
    `INSERT INTO workflow_versions (workspace_id, workflow_id, version_number, definition_json, definition_hash)
     VALUES ($1,$2,1,$3,'h') RETURNING id`,
    [workspaceId, workflowId, JSON.stringify(IR)],
  );
  return { workflowId, versionId: (ver.rows[0] as { id: string }).id };
}

/** Seed a RUNNING execution for the authed workspace, with one WAITING node + open wait. */
async function seedRunning(workspaceId: string): Promise<{ executionId: string }> {
  const { workflowId, versionId } = await seedWorkflowVersion(workspaceId);
  const ex = await pool.query(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
     VALUES ($1,$2,$3,'RUNNING') RETURNING id`,
    [workspaceId, workflowId, versionId],
  );
  const executionId = (ex.rows[0] as { id: string }).id;
  await pool.query(
    `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt) VALUES ($1,$2,'gate','WAITING',1)`,
    [workspaceId, executionId],
  );
  await openWait(pool, {
    executionId,
    nodeId: 'gate',
    attempt: 1,
    kind: 'approval',
    resumeToken: randomBytes(24).toString('base64url'),
    expiresAt: new Date(Date.now() + 3_600_000),
    fallback: 'reject',
    message: 'x',
  });
  return { executionId };
}

/** Seed an execution created via the real trigger path so its trigger payload round-trips. */
async function seedWithTrigger(workspaceId: string, payload: unknown): Promise<{ executionId: string }> {
  const { workflowId, versionId } = await seedWorkflowVersion(workspaceId);
  const { execution } = await createExecutionWithTrigger(pool, {
    workflowId,
    versionId,
    idempotencyKey: randomUUID(),
    payload,
    nodeIds: ['t'],
    executionTimeoutMs: 900_000,
  });
  return { executionId: execution.id };
}

describe('POST /v1/executions/:id/cancel', () => {
  test('cancels a running execution, skips its nodes, and closes open waits', async () => {
    const { executionId } = await seedRunning(auth.workspaceId);
    const r = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/cancel` });
    expect(r.statusCode).toBe(200);
    const detail = await pool.query(`SELECT status FROM executions WHERE id = $1`, [executionId]);
    expect((detail.rows[0] as { status: string }).status).toBe('CANCELED');
    expect((await latestNodeStates(pool, executionId)).find((n) => n.nodeId === 'gate')?.status).toBe('SKIPPED');
    expect((await waitsForExecution(pool, executionId)).every((w) => w.status !== 'open')).toBe(true);
  });

  test('records a CANCELED execution usage row on cancel', async () => {
    const { executionId } = await seedRunning(auth.workspaceId);
    await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/cancel` });
    const rows = await pool.query(
      `SELECT metadata->>'status' AS status FROM usage_events WHERE execution_id=$1 AND metric='execution'`,
      [executionId],
    );
    expect(rows.rowCount).toBe(1);
    expect((rows.rows[0] as { status: string }).status).toBe('CANCELED');
  });

  test('emits exactly one node.skipped for a WAITING node (no cancel/closeOpenWaits double-emit)', async () => {
    const { executionId } = await seedRunning(auth.workspaceId);
    await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/cancel` });
    const events = await pool.query(
      `SELECT count(*)::int AS c FROM execution_events WHERE execution_id = $1 AND event_type = 'node.skipped' AND node_id = 'gate'`,
      [executionId],
    );
    expect((events.rows[0] as { c: number }).c).toBe(1);
  });

  test('a second cancel on a terminal execution is 409', async () => {
    const { executionId } = await seedRunning(auth.workspaceId);
    await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/cancel` });
    const again = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/cancel` });
    expect(again.statusCode).toBe(409);
  });

  test('a cross-workspace cancel is 404', async () => {
    const other = await createAuthedUser(app);
    const { executionId } = await seedRunning(other.workspaceId);
    const r = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/cancel` });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /v1/executions/:id/retry', () => {
  test('replays into a new execution from the same version', async () => {
    const { executionId } = await seedRunning(auth.workspaceId);
    const r = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/retry` });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ executionId: string; created: boolean }>();
    expect(body.executionId).not.toBe(executionId);
    expect(body.created).toBe(true);
  });

  test('replays the original trigger payload into the new execution', async () => {
    const payload = { name: 'Budi', total: 150 };
    const { executionId } = await seedWithTrigger(auth.workspaceId, payload);
    const r = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/retry` });
    expect(r.statusCode).toBe(201);
    const newId = r.json<{ executionId: string }>().executionId;
    expect(await getTriggerPayload(pool, newId)).toEqual(payload);
  });

  test('retries cleanly when the original had no trigger payload', async () => {
    const { executionId } = await seedRunning(auth.workspaceId);
    const r = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/retry` });
    expect(r.statusCode).toBe(201);
    expect(await getTriggerPayload(pool, r.json<{ executionId: string }>().executionId)).toBeNull();
  });

  test('honors Idempotency-Key so a repeated retry returns the same new execution', async () => {
    const { executionId } = await seedRunning(auth.workspaceId);
    const key = randomBytes(8).toString('hex');
    const first = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/retry`, headers: { 'idempotency-key': key } });
    const second = await auth.inject({ method: 'POST', url: `/v1/executions/${executionId}/retry`, headers: { 'idempotency-key': key } });
    expect(first.json<{ executionId: string }>().executionId).toBe(second.json<{ executionId: string }>().executionId);
    expect(second.json<{ created: boolean }>().created).toBe(false);
  });
});
