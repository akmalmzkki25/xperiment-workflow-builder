import {
  casNode,
  createPool,
  fetchUnpublished,
  getExecutionDetail,
  latestNodeStates,
  openWait,
  runMigrations,
  waitsForExecution,
} from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { OrchestratorDeps } from '../src/deps.js';
import { handleExecutionRequested } from '../src/handlers/executionRequested.js';
import { handleNodeCompleted } from '../src/handlers/nodeCompleted.js';
import { branchIr, linearIr, seedExecution, truncateAll } from './helpers.js';

let pool: Pool;
let deps: OrchestratorDeps;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  deps = { pool, log: () => {} };
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

async function succeedNode(executionId: string, nodeId: string, outputPort = 'main', output: unknown = {}) {
  await casNode(pool, { executionId, nodeId, attempt: 1, from: ['PENDING'], to: 'READY' });
  await casNode(pool, { executionId, nodeId, attempt: 1, from: ['READY', 'QUEUED'], to: 'QUEUED' });
  await casNode(pool, { executionId, nodeId, attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
  await casNode(pool, {
    executionId,
    nodeId,
    attempt: 1,
    from: ['RUNNING'],
    to: 'SUCCEEDED',
    patch: { outputJson: output, outputPort, completedAt: true },
  });
  await handleNodeCompleted(deps, { executionId, nodeId, attempt: 1, status: 'SUCCEEDED', outputPort });
}

describe('handleNodeCompleted SUCCEEDED', () => {
  test('queues downstream node after upstream success', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await pool.query(`TRUNCATE task_outbox`);
    await succeedNode(executionId, 't');
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 'greet')?.status).toBe('QUEUED');
    const outbox = await fetchUnpublished(pool, 10);
    expect(outbox.map((o) => o.eventType)).toEqual(['node.task']);
    expect(outbox[0]!.payload).toEqual({ executionId, nodeId: 'greet', attempt: 1 });
  });

  test('resolves terminal SUCCEEDED when all nodes finished', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedNode(executionId, 'greet');
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('SUCCEEDED');
    expect(detail?.execution.completedAt).not.toBeNull();
    expect(detail?.events.map((e) => e.eventType)).toContain('execution.succeeded');
  });

  test('IF false: true-branch subtree skipped, false branch queued, then terminal', async () => {
    const { executionId } = await seedExecution(pool, branchIr(), { name: 'Budi', total: 50 });
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedNode(executionId, 'branch', 'false', { result: false });
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 'big')?.status).toBe('SKIPPED');
    expect(states.find((n) => n.nodeId === 'small')?.status).toBe('QUEUED');
    await succeedNode(executionId, 'small');
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('SUCCEEDED');
    const skippedEvents = detail!.events.filter((e) => e.eventType === 'node.skipped');
    expect(skippedEvents.map((e) => e.nodeId)).toContain('big');
  });
});

describe('handleNodeCompleted RETRY_SCHEDULED', () => {
  test('inserts attempt 2 QUEUED and a delayed node.task', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await casNode(pool, { executionId, nodeId: 't', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId: 't',
      attempt: 1,
      from: ['RUNNING'],
      to: 'RETRY_SCHEDULED',
      patch: { errorJson: { code: 'http_error', retryable: true }, completedAt: true },
    });
    await pool.query(`TRUNCATE task_outbox`);
    await handleNodeCompleted(deps, { executionId, nodeId: 't', attempt: 1, status: 'RETRY_SCHEDULED', delayMs: 750 });

    const states = await latestNodeStates(pool, executionId);
    const t = states.find((n) => n.nodeId === 't')!;
    expect(t.attempt).toBe(2);
    expect(t.status).toBe('QUEUED');
    const outbox = await fetchUnpublished(pool, 10);
    expect(outbox[0]!.eventType).toBe('node.task');
    expect(outbox[0]!.payload).toEqual({ executionId, nodeId: 't', attempt: 2 });
    expect(outbox[0]!.delayMs).toBe(750);
  });

  test('redelivery of the same completion is a no-op', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await casNode(pool, { executionId, nodeId: 't', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId: 't',
      attempt: 1,
      from: ['RUNNING'],
      to: 'RETRY_SCHEDULED',
      patch: { errorJson: { code: 'http_error', retryable: true } },
    });
    await handleNodeCompleted(deps, { executionId, nodeId: 't', attempt: 1, status: 'RETRY_SCHEDULED', delayMs: 10 });
    await handleNodeCompleted(deps, { executionId, nodeId: 't', attempt: 1, status: 'RETRY_SCHEDULED', delayMs: 10 });
    const r = await pool.query(
      `SELECT count(*)::int AS c FROM execution_nodes WHERE execution_id = $1 AND node_id = 't' AND attempt = 2`,
      [executionId],
    );
    expect((r.rows[0] as { c: number }).c).toBe(1);
  });
});

describe('handleNodeCompleted FAILED', () => {
  test('fails execution and skips remaining pending nodes', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await casNode(pool, { executionId, nodeId: 't', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId: 't',
      attempt: 1,
      from: ['RUNNING'],
      to: 'FAILED',
      patch: { errorJson: { code: 'http_error', message: 'HTTP 404', retryable: false }, completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId: 't', attempt: 1, status: 'FAILED' });
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('FAILED');
    expect(detail?.execution.errorSummary).toContain('t');
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 'greet')?.status).toBe('SKIPPED');
  });

  test('finalizing an execution with a configured callback enqueues one execution.callback', async () => {
    const { executionId, workflowId } = await seedExecution(pool, linearIr());
    await pool.query(
      `UPDATE workflows SET completion_webhook_url='https://example.com/h', completion_webhook_secret_encrypted='\\x00'::bytea WHERE id=$1`,
      [workflowId],
    );
    await handleExecutionRequested(deps, { executionId });
    await pool.query(`TRUNCATE task_outbox`);
    await casNode(pool, { executionId, nodeId: 't', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, { executionId, nodeId: 't', attempt: 1, from: ['RUNNING'], to: 'FAILED', patch: { errorJson: { code: 'x' }, completedAt: true } });
    await handleNodeCompleted(deps, { executionId, nodeId: 't', attempt: 1, status: 'FAILED' });
    const cb = await pool.query(
      `SELECT count(*)::int AS n FROM task_outbox WHERE event_type='execution.callback' AND payload_json->>'executionId'=$1`,
      [executionId],
    );
    expect((cb.rows[0] as { n: number }).n).toBe(1);
  });

  test("finalizing FAILED closes a sibling branch's open wait (no dangling approval)", async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    // Simulate a parallel branch already suspended on an approval while 't' runs.
    await casNode(pool, { executionId, nodeId: 'greet', attempt: 1, from: ['PENDING'], to: 'READY' });
    await casNode(pool, { executionId, nodeId: 'greet', attempt: 1, from: ['READY'], to: 'QUEUED' });
    await casNode(pool, { executionId, nodeId: 'greet', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, { executionId, nodeId: 'greet', attempt: 1, from: ['RUNNING'], to: 'WAITING' });
    await openWait(pool, {
      executionId,
      nodeId: 'greet',
      attempt: 1,
      kind: 'approval',
      resumeToken: 'tok-dangling',
      expiresAt: new Date(Date.now() + 3_600_000),
      fallback: 'reject',
      message: 'x',
    });
    // 't' fails, finalizing the execution.
    await casNode(pool, { executionId, nodeId: 't', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId: 't',
      attempt: 1,
      from: ['RUNNING'],
      to: 'FAILED',
      patch: { errorJson: { code: 'boom', retryable: false }, completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId: 't', attempt: 1, status: 'FAILED' });

    expect((await getExecutionDetail(pool, executionId))?.execution.status).toBe('FAILED');
    // The sibling wait must not dangle: it is closed and its node skipped.
    const waits = await waitsForExecution(pool, executionId);
    expect(waits.every((w) => w.status !== 'open')).toBe(true);
    expect((await latestNodeStates(pool, executionId)).find((n) => n.nodeId === 'greet')?.status).toBe('SKIPPED');
  });
});
