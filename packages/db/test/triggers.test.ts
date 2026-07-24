import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, DEFAULT_WORKSPACE_ID, runMigrations, withTx } from '../src/index.js';
import { createExecutionWithTrigger } from '../src/repos/executions.js';
import {
  deleteTriggersNotIn,
  dueScheduleTriggers,
  getTriggerByRouteKey,
  listTriggers,
  recentTestTriggerPayloads,
  setTriggersActive,
  setWorkflowActive,
  updateNextFireAt,
  upsertTrigger,
} from '../src/repos/triggers.js';
import { createVersion, createWorkflow, getWorkflow } from '../src/repos/workflows.js';

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
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'T' });
  workflowId = wf.id;
  versionId = (await createVersion(pool, { workflowId, definition: {}, hash: 'h' })).id;
});

describe('triggers repo', () => {
  test('upsert creates a webhook row with route key, preserves it on re-upsert', async () => {
    const first = await upsertTrigger(pool, {
      workflowId,
      nodeId: 'hook',
      type: 'webhook',
      authMode: 'hmac',
      secretEncrypted: Buffer.from('enc-1'),
    });
    expect(first.routeKey.length).toBeGreaterThanOrEqual(24);
    const again = await upsertTrigger(pool, {
      workflowId,
      nodeId: 'hook',
      type: 'webhook',
      authMode: 'token',
      secretEncrypted: Buffer.from('enc-2'),
    });
    expect(again.id).toBe(first.id);
    expect(again.routeKey).toBe(first.routeKey); // preserved
    expect(again.secretEncrypted?.toString()).toBe('enc-1'); // preserved when present
    expect(again.authMode).toBe('token'); // config refreshed
  });

  test('lookup by route key and workflow listing', async () => {
    const row = await upsertTrigger(pool, { workflowId, nodeId: 'hook', type: 'webhook', authMode: 'none' });
    expect((await getTriggerByRouteKey(pool, row.routeKey))?.id).toBe(row.id);
    expect(await getTriggerByRouteKey(pool, 'nope')).toBeNull();
    expect(await listTriggers(pool, workflowId)).toHaveLength(1);
  });

  test('activation flags and pruning removed nodes', async () => {
    await upsertTrigger(pool, { workflowId, nodeId: 'a', type: 'webhook', authMode: 'none' });
    await upsertTrigger(pool, { workflowId, nodeId: 'b', type: 'schedule', cron: '* * * * *', timezone: 'UTC' });
    await setTriggersActive(pool, workflowId, true);
    await setWorkflowActive(pool, workflowId, true);
    expect((await listTriggers(pool, workflowId)).every((t) => t.active)).toBe(true);
    const wf = await getWorkflow(pool, workflowId);
    expect(wf?.active).toBe(true);
    await deleteTriggersNotIn(pool, workflowId, ['a']);
    const remaining = await listTriggers(pool, workflowId);
    expect(remaining.map((t) => t.nodeId)).toEqual(['a']);
  });

  test('due schedule triggers use SKIP LOCKED: second tx sees nothing', async () => {
    await upsertTrigger(pool, {
      workflowId,
      nodeId: 's',
      type: 'schedule',
      cron: '* * * * *',
      timezone: 'UTC',
      nextFireAt: new Date(Date.now() - 1000),
    });
    await setTriggersActive(pool, workflowId, true);
    await withTx(pool, async (c1: PoolClient) => {
      const due1 = await dueScheduleTriggers(c1, 10);
      expect(due1).toHaveLength(1);
      await withTx(pool, async (c2: PoolClient) => {
        const due2 = await dueScheduleTriggers(c2, 10);
        expect(due2).toHaveLength(0); // locked by c1
      });
    });
  });

  test('updateNextFireAt moves a trigger out of the due set', async () => {
    const row = await upsertTrigger(pool, {
      workflowId,
      nodeId: 's',
      type: 'schedule',
      cron: '* * * * *',
      timezone: 'UTC',
      nextFireAt: new Date(Date.now() - 1000),
    });
    await setTriggersActive(pool, workflowId, true);
    await updateNextFireAt(pool, row.id, new Date(Date.now() + 3600_000));
    await withTx(pool, async (c) => {
      expect(await dueScheduleTriggers(c, 10)).toHaveLength(0);
    });
  });

  test('recentTestTriggerPayloads returns only test-mode payloads, newest first', async () => {
    for (const [i, mode] of [
      [0, 'test'],
      [1, 'production'],
      [2, 'test'],
    ] as const) {
      const { execution } = await createExecutionWithTrigger(pool, {
        workflowId,
        versionId,
        idempotencyKey: `s-${i}`,
        payload: { n: i },
        nodeIds: ['t'],
        executionTimeoutMs: 60000,
      });
      await pool.query(`UPDATE executions SET mode = $1 WHERE id = $2`, [mode, execution.id]);
    }
    const samples = await recentTestTriggerPayloads(pool, workflowId, 5);
    expect(samples).toEqual([{ n: 2 }, { n: 0 }]);
  });
});
