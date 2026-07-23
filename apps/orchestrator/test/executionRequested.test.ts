import { createPool, fetchUnpublished, getExecutionDetail, latestNodeStates, runMigrations } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { OrchestratorDeps } from '../src/deps.js';
import { handleExecutionRequested } from '../src/handlers/executionRequested.js';
import { linearIr, seedExecution, truncateAll } from './helpers.js';

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

describe('handleExecutionRequested', () => {
  test('moves execution to RUNNING and queues the entrypoint task', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await pool.query(`TRUNCATE task_outbox`); // drop creation-time outbox rows for clarity
    await handleExecutionRequested(deps, { executionId });

    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('RUNNING');
    expect(detail?.execution.startedAt).not.toBeNull();

    const nodes = await latestNodeStates(pool, executionId);
    expect(nodes.find((n) => n.nodeId === 't')?.status).toBe('QUEUED');
    expect(nodes.find((n) => n.nodeId === 'greet')?.status).toBe('PENDING');

    const outbox = await fetchUnpublished(pool, 10);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('node.task');
    expect(outbox[0]!.payload).toEqual({ executionId, nodeId: 't', attempt: 1 });

    const eventTypes = detail!.events.map((e) => e.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining(['execution.queued', 'node.ready', 'node.queued', 'execution.running']),
    );
  });

  test('duplicate delivery is a no-op', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await pool.query(`TRUNCATE task_outbox`);
    await handleExecutionRequested(deps, { executionId });
    await handleExecutionRequested(deps, { executionId }); // redelivery
    const outbox = await fetchUnpublished(pool, 10);
    expect(outbox).toHaveLength(1); // still exactly one node.task
  });

  test('unknown execution logs and returns without throwing', async () => {
    await expect(
      handleExecutionRequested(deps, { executionId: '00000000-0000-0000-0000-0000000000cc' }),
    ).resolves.toBeUndefined();
  });
});
