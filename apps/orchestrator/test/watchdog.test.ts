import { createPool, getExecutionDetail, latestNodeStates, openWait, runMigrations } from '@xperiment/db';
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

  test('records a TIMED_OUT execution usage row', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await handleWatchdog(deps, { executionId });
    const rows = await pool.query(
      `SELECT metadata->>'status' AS status FROM usage_events WHERE execution_id=$1 AND metric='execution'`,
      [executionId],
    );
    expect(rows.rowCount).toBe(1);
    expect((rows.rows[0] as { status: string }).status).toBe('TIMED_OUT');
    // nodeCount is counted from the pre-transition snapshot (t=QUEUED, greet=PENDING),
    // so a fresh timeout has nodeCount 0 → no `node` row is emitted.
    const metrics = await pool.query(`SELECT metric FROM usage_events WHERE execution_id=$1`, [executionId]);
    expect((metrics.rows as { metric: string }[]).map((r) => r.metric)).not.toContain('node');
  });

  test('skips an execution with an open wait instead of timing it out', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    // Simulate a suspended node with an open wait.
    await pool.query(`UPDATE execution_nodes SET status = 'WAITING' WHERE execution_id = $1 AND node_id = 't'`, [
      executionId,
    ]);
    await openWait(pool, {
      executionId,
      nodeId: 't',
      attempt: 1,
      kind: 'approval',
      resumeToken: 'tok-open-guard',
      expiresAt: new Date(Date.now() + 3_600_000),
      fallback: 'reject',
      message: 'x',
    });
    await handleWatchdog(deps, { executionId });
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('RUNNING');
    expect(detail?.events.map((e) => e.eventType)).not.toContain('execution.timed_out');
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
