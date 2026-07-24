import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, runMigrations, withTx } from '../src/index.js';
import { createUser, createWorkspaceWithOwner } from '../src/repos/auth.js';
import {
  applyResume,
  closeOpenWaits,
  dueWaits,
  getOpenApprovalWait,
  getOpenWaitByToken,
  listOpenApprovals,
  openWait,
  resolveWait,
  waitsForExecution,
} from '../src/repos/waits.js';
import { latestNodeStates } from '../src/repos/executions.js';

async function countCompletions(pool2: Pool, executionId: string, nodeId: string): Promise<number> {
  const r = await pool2.query(
    `SELECT count(*)::int AS n FROM task_outbox WHERE event_type='node.completed'
       AND payload_json->>'executionId'=$1 AND payload_json->>'nodeId'=$2`,
    [executionId, nodeId],
  );
  return (r.rows[0] as { n: number }).n;
}

let pool: Pool;
let workspaceId: string;
let userId: string;

/** Seed a minimal execution row directly so waits can reference it. */
async function seedExecution(nodeId = 'wait'): Promise<string> {
  const wf = await pool.query(
    `INSERT INTO workflows (workspace_id, name) VALUES ($1, 'w') RETURNING id`,
    [workspaceId],
  );
  const workflowId = (wf.rows[0] as { id: string }).id;
  const ver = await pool.query(
    `INSERT INTO workflow_versions (workspace_id, workflow_id, version_number, definition_json, definition_hash)
     VALUES ($1, $2, 1, '{}'::jsonb, 'h') RETURNING id`,
    [workspaceId, workflowId],
  );
  const versionId = (ver.rows[0] as { id: string }).id;
  const ex = await pool.query(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
     VALUES ($1, $2, $3, 'RUNNING') RETURNING id`,
    [workspaceId, workflowId, versionId],
  );
  const executionId = (ex.rows[0] as { id: string }).id;
  await pool.query(
    `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt)
     VALUES ($1, $2, $3, 'WAITING', 1)`,
    [workspaceId, executionId, nodeId],
  );
  return executionId;
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  // Only clear execution-scoped tables; leave the migration-seeded default
  // workspace and any users/workspaces other test files depend on intact.
  await pool.query(
    `TRUNCATE execution_waits, execution_nodes, execution_events, executions,
     workflow_versions, workflow_drafts, workflows CASCADE`,
  );
  const user = (await createUser(pool, { email: `w-${randomBytes(4).toString('hex')}@x.test`, passwordHash: 'h' }))!;
  userId = user.id;
  const ws = await createWorkspaceWithOwner(pool, { name: 'W', userId });
  workspaceId = ws.id;
});

describe('execution_waits repo', () => {
  test('openWait inherits workspace_id from the execution', async () => {
    const executionId = await seedExecution();
    const wait = await openWait(pool, {
      executionId,
      nodeId: 'wait',
      attempt: 1,
      kind: 'timer',
      resumeAt: new Date(Date.now() + 60_000),
    });
    expect(wait.kind).toBe('timer');
    expect(wait.status).toBe('open');
    const all = await waitsForExecution(pool, executionId);
    expect(all).toHaveLength(1);
    expect(all[0]!.executionId).toBe(executionId);
  });

  test('token + approval lookups only see open waits; resolveWait is idempotent', async () => {
    const executionId = await seedExecution('appr');
    const token = randomBytes(24).toString('base64url');
    const wait = await openWait(pool, {
      executionId,
      nodeId: 'appr',
      attempt: 1,
      kind: 'approval',
      resumeToken: token,
      expiresAt: new Date(Date.now() + 60_000),
      fallback: 'reject',
      message: 'Approve?',
    });
    expect((await getOpenWaitByToken(pool, token))?.id).toBe(wait.id);
    expect((await getOpenApprovalWait(pool, { executionId, nodeId: 'appr', workspaceId }))?.id).toBe(wait.id);
    const approvals = await listOpenApprovals(pool, { workspaceId, limit: 10 });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.nodeId).toBe('appr');

    const resolved = await withTx(pool, (client) =>
      resolveWait(client, { waitId: wait.id, status: 'resolved', decision: 'reject', resolvedBy: userId }),
    );
    expect(resolved).toBe(true);
    const again = await withTx(pool, (client) => resolveWait(client, { waitId: wait.id, status: 'resolved' }));
    expect(again).toBe(false);
    expect(await getOpenWaitByToken(pool, token)).toBeNull();
    expect(await listOpenApprovals(pool, { workspaceId, limit: 10 })).toHaveLength(0);
  });

  test('dueWaits returns rows past resume_at or expires_at and skips future ones', async () => {
    const e1 = await seedExecution('a');
    const e2 = await seedExecution('b');
    await openWait(pool, { executionId: e1, nodeId: 'a', attempt: 1, kind: 'timer', resumeAt: new Date(Date.now() - 1000) });
    await openWait(pool, { executionId: e2, nodeId: 'b', attempt: 1, kind: 'timer', resumeAt: new Date(Date.now() + 60_000) });
    const due = await withTx(pool, (client) => dueWaits(client, 10));
    expect(due).toHaveLength(1);
    expect(due[0]!.executionId).toBe(e1);
  });

  test('closeOpenWaits closes open waits and skips their WAITING nodes', async () => {
    const executionId = await seedExecution('gate');
    await openWait(pool, {
      executionId,
      nodeId: 'gate',
      attempt: 1,
      kind: 'approval',
      resumeToken: randomBytes(24).toString('base64url'),
      expiresAt: new Date(Date.now() + 60_000),
      fallback: 'reject',
      message: 'x',
    });
    const closed = await withTx(pool, (client) => closeOpenWaits(client, executionId));
    expect(closed).toBe(1);
    expect((await waitsForExecution(pool, executionId))[0]!.status).toBe('expired');
    expect((await latestNodeStates(pool, executionId)).find((n) => n.nodeId === 'gate')?.status).toBe('SKIPPED');
    // No completion is emitted for a wait that was force-closed on finalization.
    expect(await countCompletions(pool, executionId, 'gate')).toBe(0);
  });

  test('applyResume is idempotent and emits exactly one completion', async () => {
    const executionId = await seedExecution('appr');
    const wait = await openWait(pool, {
      executionId,
      nodeId: 'appr',
      attempt: 1,
      kind: 'approval',
      resumeToken: randomBytes(24).toString('base64url'),
      expiresAt: new Date(Date.now() + 60_000),
      fallback: 'reject',
      message: 'x',
    });
    const ref = { id: wait.id, executionId, nodeId: 'appr', attempt: 1 };
    const first = await withTx(pool, (client) =>
      applyResume(client, { wait: ref, waitStatus: 'resolved', terminal: 'SUCCEEDED', outputPort: 'approved', output: {} }),
    );
    const second = await withTx(pool, (client) =>
      applyResume(client, { wait: ref, waitStatus: 'resolved', terminal: 'SUCCEEDED', outputPort: 'approved', output: {} }),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await countCompletions(pool, executionId, 'appr')).toBe(1);
  });

  test('applyResume no-ops (no completion) when the node already left WAITING', async () => {
    const executionId = await seedExecution('stuck');
    const wait = await openWait(pool, {
      executionId,
      nodeId: 'stuck',
      attempt: 1,
      kind: 'event',
      resumeToken: randomBytes(24).toString('base64url'),
    });
    // Node was force-skipped (e.g. execution failed elsewhere) but the wait row lingers open.
    await pool.query(`UPDATE execution_nodes SET status='SKIPPED' WHERE execution_id=$1 AND node_id='stuck'`, [executionId]);
    const ok = await withTx(pool, (client) =>
      applyResume(client, {
        wait: { id: wait.id, executionId, nodeId: 'stuck', attempt: 1 },
        waitStatus: 'resolved',
        terminal: 'SUCCEEDED',
        outputPort: 'main',
        output: {},
      }),
    );
    expect(ok).toBe(false);
    expect(await countCompletions(pool, executionId, 'stuck')).toBe(0);
  });

  test('listOpenApprovals is scoped to the workspace', async () => {
    const executionId = await seedExecution('appr');
    await openWait(pool, {
      executionId,
      nodeId: 'appr',
      attempt: 1,
      kind: 'approval',
      resumeToken: randomBytes(24).toString('base64url'),
      expiresAt: new Date(Date.now() + 60_000),
      fallback: 'fail',
      message: 'x',
    });
    const other = await createWorkspaceWithOwner(pool, { name: 'Other', userId });
    expect(await listOpenApprovals(pool, { workspaceId: other.id, limit: 10 })).toHaveLength(0);
  });
});
