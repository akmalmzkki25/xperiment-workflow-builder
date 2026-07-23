import { createPool, getExecutionDetail, latestNodeStates, runMigrations } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { OrchestratorDeps } from '../src/deps.js';
import { handleExecutionRequested } from '../src/handlers/executionRequested.js';
import { handleWatchdog } from '../src/handlers/watchdog.js';
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

describe('handleWatchdog', () => {
  test('times out a RUNNING execution and fails its non-terminal nodes', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await handleWatchdog(deps, { executionId });
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('TIMED_OUT');
    expect(detail?.events.map((e) => e.eventType)).toContain('execution.timed_out');
    const states = await latestNodeStates(pool, executionId);
    for (const s of states) expect(['FAILED', 'SKIPPED']).toContain(s.status);
    const failed = await pool.query(
      `SELECT error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = 't' AND attempt = 1`,
      [executionId],
    );
    expect((failed.rows[0] as { error_json: { code: string } }).error_json.code).toBe('execution_timeout');
  });

  test('is a no-op on a terminal execution', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await handleWatchdog(deps, { executionId });
    const before = await getExecutionDetail(pool, executionId);
    await handleWatchdog(deps, { executionId }); // second firing
    const after = await getExecutionDetail(pool, executionId);
    expect(after?.execution.status).toBe(before?.execution.status);
    expect(after?.events.filter((e) => e.eventType === 'execution.timed_out')).toHaveLength(1);
  });
});
