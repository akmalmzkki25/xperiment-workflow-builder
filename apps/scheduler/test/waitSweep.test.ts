import { createPool, DEFAULT_WORKSPACE_ID, latestNodeStates, openWait, runMigrations } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runWaitSweep } from '../src/waitSweep.js';

let pool: Pool;

async function seedWaitingExecution(nodeId: string): Promise<string> {
  const wf = await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'w') RETURNING id`, [
    DEFAULT_WORKSPACE_ID,
  ]);
  const workflowId = (wf.rows[0] as { id: string }).id;
  const ver = await pool.query(
    `INSERT INTO workflow_versions (workspace_id, workflow_id, version_number, definition_json, definition_hash)
     VALUES ($1,$2,1,'{}'::jsonb,'h') RETURNING id`,
    [DEFAULT_WORKSPACE_ID, workflowId],
  );
  const versionId = (ver.rows[0] as { id: string }).id;
  const ex = await pool.query(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
     VALUES ($1,$2,$3,'RUNNING') RETURNING id`,
    [DEFAULT_WORKSPACE_ID, workflowId, versionId],
  );
  const executionId = (ex.rows[0] as { id: string }).id;
  await pool.query(
    `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt)
     VALUES ($1,$2,$3,'WAITING',1)`,
    [DEFAULT_WORKSPACE_ID, executionId, nodeId],
  );
  return executionId;
}

const status = async (executionId: string, nodeId: string) =>
  (await latestNodeStates(pool, executionId)).find((n) => n.nodeId === nodeId)?.status;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE execution_waits, execution_nodes, execution_events, executions, task_outbox,
     workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

describe('runWaitSweep', () => {
  test('resumes a due timer to SUCCEEDED and queues a completion', async () => {
    const executionId = await seedWaitingExecution('wait');
    await openWait(pool, { executionId, nodeId: 'wait', attempt: 1, kind: 'timer', resumeAt: new Date(Date.now() - 1000) });

    const r = await runWaitSweep({ pool, log: () => {} });
    expect(r.resumed).toBe(1);
    expect(await status(executionId, 'wait')).toBe('SUCCEEDED');
    const outbox = await pool.query(
      `SELECT payload_json->>'status' AS s FROM task_outbox WHERE event_type='node.completed' AND payload_json->>'nodeId'='wait'`,
    );
    expect((outbox.rows[0] as { s: string }).s).toBe('SUCCEEDED');
  });

  test('applies the reject fallback when an approval expires', async () => {
    const executionId = await seedWaitingExecution('appr');
    await openWait(pool, {
      executionId,
      nodeId: 'appr',
      attempt: 1,
      kind: 'approval',
      resumeToken: 'tok-expired-reject',
      expiresAt: new Date(Date.now() - 1000),
      fallback: 'reject',
      message: 'x',
    });

    const r = await runWaitSweep({ pool, log: () => {} });
    expect(r.expired).toBe(1);
    expect(await status(executionId, 'appr')).toBe('SUCCEEDED');
    const node = await pool.query(
      `SELECT output_port FROM execution_nodes WHERE execution_id=$1 AND node_id='appr'`,
      [executionId],
    );
    expect((node.rows[0] as { output_port: string }).output_port).toBe('rejected');
  });

  test('approve fallback resumes on the approved port; fail fallback fails the node', async () => {
    const approveExec = await seedWaitingExecution('a1');
    await openWait(pool, {
      executionId: approveExec,
      nodeId: 'a1',
      attempt: 1,
      kind: 'approval',
      resumeToken: 'tok-exp-approve',
      expiresAt: new Date(Date.now() - 1000),
      fallback: 'approve',
      message: 'x',
    });
    const failExec = await seedWaitingExecution('a2');
    await openWait(pool, {
      executionId: failExec,
      nodeId: 'a2',
      attempt: 1,
      kind: 'approval',
      resumeToken: 'tok-exp-fail',
      expiresAt: new Date(Date.now() - 1000),
      fallback: 'fail',
      message: 'x',
    });

    await runWaitSweep({ pool, log: () => {} });

    const approved = await pool.query(
      `SELECT status, output_port FROM execution_nodes WHERE execution_id=$1 AND node_id='a1'`,
      [approveExec],
    );
    expect((approved.rows[0] as { status: string; output_port: string }).status).toBe('SUCCEEDED');
    expect((approved.rows[0] as { output_port: string }).output_port).toBe('approved');
    expect(await status(failExec, 'a2')).toBe('FAILED');
  });

  test('fails the node when an event wait times out', async () => {
    const executionId = await seedWaitingExecution('evt');
    await openWait(pool, {
      executionId,
      nodeId: 'evt',
      attempt: 1,
      kind: 'event',
      resumeToken: 'tok-expired-evt',
      expiresAt: new Date(Date.now() - 1000),
    });

    await runWaitSweep({ pool, log: () => {} });
    expect(await status(executionId, 'evt')).toBe('FAILED');
  });

  test('leaves future waits untouched', async () => {
    const executionId = await seedWaitingExecution('later');
    await openWait(pool, { executionId, nodeId: 'later', attempt: 1, kind: 'timer', resumeAt: new Date(Date.now() + 60000) });
    const r = await runWaitSweep({ pool, log: () => {} });
    expect(r).toEqual({ resumed: 0, expired: 0 });
    expect(await status(executionId, 'later')).toBe('WAITING');
  });
});
