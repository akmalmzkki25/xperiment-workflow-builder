import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, runMigrations } from '../src/index.js';
import { createVersion, createWorkflow } from '../src/repos/workflows.js';
import {
  appendEvent,
  casExecution,
  casNode,
  createExecutionWithTrigger,
  getExecutionDetail,
  getTriggerPayload,
  insertNodeAttempt,
  latestNodeStates,
  listExecutions,
  PayloadTooLargeError,
  succeededOutputs,
} from '../src/repos/executions.js';
import { fetchUnpublished, markPublished } from '../src/repos/outbox.js';

let pool: Pool;
let workflowId: string;
let versionId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
  const wf = await createWorkflow(pool, { name: 'X' });
  workflowId = wf.id;
  versionId = (await createVersion(pool, { workflowId, definition: { nodes: [] }, hash: 'h' })).id;
});

function createArgs(key = 'k1') {
  return {
    workflowId,
    versionId,
    idempotencyKey: key,
    payload: { name: 'Budi' },
    nodeIds: ['t', 'a', 'b'],
    executionTimeoutMs: 900000,
  };
}

describe('createExecutionWithTrigger', () => {
  test('creates execution, PENDING node rows, outbox rows, event — atomically', async () => {
    const { execution, created } = await createExecutionWithTrigger(pool, createArgs());
    expect(created).toBe(true);
    expect(execution.status).toBe('CREATED');
    const nodes = await latestNodeStates(pool, execution.id);
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.status === 'PENDING' && n.attempt === 1)).toBe(true);
    const outbox = await fetchUnpublished(pool, 10);
    const types = outbox.map((o) => o.eventType).sort();
    expect(types).toEqual(['execution.requested', 'execution.watchdog']);
    const watchdog = outbox.find((o) => o.eventType === 'execution.watchdog')!;
    expect(watchdog.delayMs).toBe(900000);
    expect(await getTriggerPayload(pool, execution.id)).toEqual({ name: 'Budi' });
  });

  test('duplicate idempotency key returns existing execution with created:false', async () => {
    const first = await createExecutionWithTrigger(pool, createArgs('same'));
    const second = await createExecutionWithTrigger(pool, createArgs('same'));
    expect(second.created).toBe(false);
    expect(second.execution.id).toBe(first.execution.id);
    const r = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((r.rows[0] as { c: number }).c).toBe(1);
  });
});

describe('CAS updates', () => {
  test('casExecution succeeds from expected status and refuses otherwise', async () => {
    const { execution } = await createExecutionWithTrigger(pool, createArgs());
    expect(await casExecution(pool, { executionId: execution.id, from: ['CREATED'], to: 'QUEUED' })).toBe(true);
    expect(await casExecution(pool, { executionId: execution.id, from: ['CREATED'], to: 'QUEUED' })).toBe(false);
    expect(
      await casExecution(pool, { executionId: execution.id, from: ['QUEUED'], to: 'RUNNING', startedAt: true }),
    ).toBe(true);
  });

  test('casNode transitions one attempt row and stores patch', async () => {
    const { execution } = await createExecutionWithTrigger(pool, createArgs());
    expect(
      await casNode(pool, { executionId: execution.id, nodeId: 't', attempt: 1, from: ['PENDING'], to: 'READY' }),
    ).toBe(true);
    expect(
      await casNode(pool, { executionId: execution.id, nodeId: 't', attempt: 1, from: ['READY'], to: 'QUEUED' }),
    ).toBe(true);
    expect(
      await casNode(pool, {
        executionId: execution.id,
        nodeId: 't',
        attempt: 1,
        from: ['QUEUED'],
        to: 'RUNNING',
        patch: { startedAt: true, workerId: 'w-1' },
      }),
    ).toBe(true);
    expect(
      await casNode(pool, {
        executionId: execution.id,
        nodeId: 't',
        attempt: 1,
        from: ['RUNNING'],
        to: 'SUCCEEDED',
        patch: { outputJson: { ok: true }, outputPort: 'main', completedAt: true },
      }),
    ).toBe(true);
    // duplicate delivery: same transition again fails cleanly
    expect(
      await casNode(pool, { executionId: execution.id, nodeId: 't', attempt: 1, from: ['RUNNING'], to: 'SUCCEEDED' }),
    ).toBe(false);
    const outputs = await succeededOutputs(pool, execution.id);
    expect(outputs['t']).toEqual({ ok: true });
  });

  test('payload cap enforced', async () => {
    const { execution } = await createExecutionWithTrigger(pool, createArgs());
    const huge = { data: 'x'.repeat(262145) };
    await expect(
      casNode(pool, {
        executionId: execution.id,
        nodeId: 't',
        attempt: 1,
        from: ['PENDING'],
        to: 'FAILED',
        patch: { outputJson: huge },
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});

describe('attempts and reads', () => {
  test('latestNodeStates picks max attempt; insertNodeAttempt adds QUEUED row', async () => {
    const { execution } = await createExecutionWithTrigger(pool, createArgs());
    await casNode(pool, { executionId: execution.id, nodeId: 'a', attempt: 1, from: ['PENDING'], to: 'READY' });
    await casNode(pool, { executionId: execution.id, nodeId: 'a', attempt: 1, from: ['READY'], to: 'QUEUED' });
    await casNode(pool, { executionId: execution.id, nodeId: 'a', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId: execution.id,
      nodeId: 'a',
      attempt: 1,
      from: ['RUNNING'],
      to: 'RETRY_SCHEDULED',
      patch: { errorJson: { code: 'http_error', retryable: true } },
    });
    await insertNodeAttempt(pool, { executionId: execution.id, nodeId: 'a', attempt: 2, status: 'QUEUED' });
    const states = await latestNodeStates(pool, execution.id);
    const a = states.find((s) => s.nodeId === 'a')!;
    expect(a.attempt).toBe(2);
    expect(a.status).toBe('QUEUED');
  });

  test('appendEvent and getExecutionDetail return full timeline', async () => {
    const { execution } = await createExecutionWithTrigger(pool, createArgs());
    await appendEvent(pool, { executionId: execution.id, eventType: 'node.started', nodeId: 't' });
    const detail = await getExecutionDetail(pool, execution.id);
    expect(detail?.execution.id).toBe(execution.id);
    expect(detail?.nodes.length).toBe(3);
    expect(detail?.events.map((e) => e.eventType)).toContain('execution.created');
    expect(detail?.events.map((e) => e.eventType)).toContain('node.started');
  });

  test('listExecutions filters by workflow and paginates', async () => {
    for (let i = 0; i < 3; i += 1) await createExecutionWithTrigger(pool, createArgs(`k${i}`));
    const page = await listExecutions(pool, { workflowId, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('outbox', () => {
  test('fetchUnpublished then markPublished removes rows from next fetch', async () => {
    await createExecutionWithTrigger(pool, createArgs());
    const rows = await fetchUnpublished(pool, 10);
    expect(rows.length).toBe(2);
    await markPublished(pool, rows.map((r) => r.id));
    expect(await fetchUnpublished(pool, 10)).toHaveLength(0);
  });
});
