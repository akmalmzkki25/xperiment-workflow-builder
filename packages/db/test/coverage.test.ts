import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, DEFAULT_WORKSPACE_ID, runMigrations, withTx } from '../src/index.js';
import {
  casExecution,
  createExecutionWithTrigger,
  getExecutionDetail,
  getTriggerPayload,
  listExecutions,
} from '../src/repos/executions.js';
import { fetchUnpublished, markPublished } from '../src/repos/outbox.js';
import { createVersion, createWorkflow, getDraft, getVersion, getWorkflow, updateDraft } from '../src/repos/workflows.js';

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
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Cov' });
  workflowId = wf.id;
  versionId = (await createVersion(pool, { workflowId, definition: {}, hash: 'h' })).id;
});

describe('withTx', () => {
  test('rolls back and rethrows on error', async () => {
    await expect(
      withTx(pool, async (client) => {
        await client.query(`INSERT INTO workspaces (id, name) VALUES ('00000000-0000-0000-0000-00000000c0de', 'tx')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const r = await pool.query(`SELECT count(*)::int AS c FROM workspaces WHERE name = 'tx'`);
    expect((r.rows[0] as { c: number }).c).toBe(0);
  });
});

describe('runMigrations apply paths', () => {
  test('applies new migrations from a directory and reports them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xperiment-mig-'));
    await writeFile(join(dir, '9001_cov.sql'), `CREATE TABLE IF NOT EXISTS cov_extra (id INT PRIMARY KEY);`);
    const applied = await runMigrations(pool, dir);
    expect(applied).toEqual(['9001_cov.sql']);
    const again = await runMigrations(pool, dir);
    expect(again).toEqual([]);
    await pool.query(`DROP TABLE IF EXISTS cov_extra`);
    await pool.query(`DELETE FROM schema_migrations WHERE id = '9001_cov.sql'`);
  });

  test('failing migration rolls back and throws with the file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xperiment-migfail-'));
    await writeFile(join(dir, '9002_bad.sql'), `THIS IS NOT SQL;`);
    await expect(runMigrations(pool, dir)).rejects.toThrow(/9002_bad\.sql failed/);
    const r = await pool.query(`SELECT count(*)::int AS c FROM schema_migrations WHERE id = '9002_bad.sql'`);
    expect((r.rows[0] as { c: number }).c).toBe(0);
  });
});

describe('misc branch coverage', () => {
  test('missing-row reads return null', async () => {
    const ghost = '00000000-0000-0000-0000-0000000000ee';
    expect(await getWorkflow(pool, ghost)).toBeNull();
    expect(await getDraft(pool, ghost)).toBeNull();
    expect(await getVersion(pool, ghost)).toBeNull();
    expect(await getExecutionDetail(pool, ghost)).toBeNull();
    expect(await getTriggerPayload(pool, ghost)).toBeNull();
    expect(await updateDraft(pool, { workflowId: ghost, definition: {}, expectedRevision: 1 })).toBeNull();
  });

  test('markPublished with empty list is a no-op', async () => {
    await expect(markPublished(pool, [])).resolves.toBeUndefined();
  });

  test('casExecution stores errorSummary and completedAt', async () => {
    const { execution } = await createExecutionWithTrigger(pool, {
      workflowId,
      versionId,
      idempotencyKey: 'cov-1',
      payload: null,
      nodeIds: ['t'],
      executionTimeoutMs: 1000,
    });
    await casExecution(pool, { executionId: execution.id, from: ['CREATED'], to: 'QUEUED' });
    await casExecution(pool, { executionId: execution.id, from: ['QUEUED'], to: 'RUNNING', startedAt: true });
    const ok = await casExecution(pool, {
      executionId: execution.id,
      from: ['RUNNING'],
      to: 'FAILED',
      completedAt: true,
      errorSummary: 'covered',
    });
    expect(ok).toBe(true);
    const detail = await getExecutionDetail(pool, execution.id);
    expect(detail?.execution.errorSummary).toBe('covered');
    expect(detail?.execution.completedAt).not.toBeNull();
  });

  test('listExecutions follows a cursor to the next page', async () => {
    for (let i = 0; i < 3; i += 1) {
      await createExecutionWithTrigger(pool, {
        workflowId,
        versionId,
        idempotencyKey: `cov-page-${i}`,
        payload: null,
        nodeIds: ['t'],
        executionTimeoutMs: 1000,
      });
    }
    const page1 = await listExecutions(pool, { workflowId, limit: 2 });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listExecutions(pool, { workflowId, limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.length).toBe(1);
    expect(page2.nextCursor).toBeNull();
  });

  test('fetchUnpublished respects the limit', async () => {
    await createExecutionWithTrigger(pool, {
      workflowId,
      versionId,
      idempotencyKey: 'cov-limit',
      payload: null,
      nodeIds: ['t'],
      executionTimeoutMs: 1000,
    });
    const rows = await fetchUnpublished(pool, 1);
    expect(rows).toHaveLength(1);
  });
});
