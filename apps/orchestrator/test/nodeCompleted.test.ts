import {
  casNode,
  createPool,
  fetchUnpublished,
  getExecutionDetail,
  latestNodeStates,
  nodeOutputs,
  openWait,
  runMigrations,
  waitsForExecution,
} from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { OrchestratorDeps } from '../src/deps.js';
import { handleExecutionRequested } from '../src/handlers/executionRequested.js';
import { handleNodeCompleted } from '../src/handlers/nodeCompleted.js';
import { handleWatchdog } from '../src/handlers/watchdog.js';
import {
  branchIr,
  errorPathIr,
  fanInIr,
  linearIr,
  loopIr,
  loopWithBranchIr,
  parallelIr,
  seedExecution,
  truncateAll,
} from './helpers.js';

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

  test('records execution usage exactly once on SUCCEEDED (redelivery does not double-count)', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedNode(executionId, 'greet'); // resolves terminal SUCCEEDED + emits usage
    // Redeliver the final completion — the CAS guard must prevent a 2nd execution row.
    await handleNodeCompleted(deps, { executionId, nodeId: 'greet', attempt: 1, status: 'SUCCEEDED', outputPort: 'main' });
    const rows = await pool.query(
      `SELECT metric, quantity, metadata->>'status' AS status FROM usage_events WHERE execution_id=$1`,
      [executionId],
    );
    const exec = (rows.rows as { metric: string; status: string }[]).filter((r) => r.metric === 'execution');
    expect(exec).toHaveLength(1);
    expect(exec[0]!.status).toBe('SUCCEEDED');
    const metrics = (rows.rows as { metric: string }[]).map((r) => r.metric).sort();
    expect(metrics).toEqual(['compute_ms', 'execution', 'node']); // both nodes ran → node qty 2 > 0
  });

  test('a watchdog firing after SUCCEEDED adds no second usage row (cross-handler exactly-once)', async () => {
    const { executionId } = await seedExecution(pool, linearIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedNode(executionId, 'greet'); // terminal SUCCEEDED → one execution row
    await handleWatchdog(deps, { executionId }); // must be a no-op (terminal guard + CAS)
    const rows = await pool.query(
      `SELECT count(*)::int AS c FROM usage_events WHERE execution_id=$1 AND metric='execution'`,
      [executionId],
    );
    expect((rows.rows[0] as { c: number }).c).toBe(1);
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
    // The direct-FAILED finalize path records exactly one FAILED execution usage row.
    const usage = await pool.query(
      `SELECT count(*)::int AS c FROM usage_events WHERE execution_id=$1 AND metric='execution' AND metadata->>'status'='FAILED'`,
      [executionId],
    );
    expect((usage.rows[0] as { c: number }).c).toBe(1);
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

describe('handleNodeCompleted error path', () => {
  /** Drives a node from PENDING to FAILED, the way the worker's recordFailure does. */
  async function failNode(executionId: string, nodeId: string) {
    await casNode(pool, { executionId, nodeId, attempt: 1, from: ['PENDING'], to: 'READY' });
    await casNode(pool, { executionId, nodeId, attempt: 1, from: ['READY', 'QUEUED'], to: 'QUEUED' });
    await casNode(pool, { executionId, nodeId, attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId,
      attempt: 1,
      from: ['RUNNING'],
      to: 'FAILED',
      patch: { errorJson: { code: 'http_error', message: 'HTTP 500', retryable: false }, completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId, attempt: 1, status: 'FAILED' });
  }

  test('a failed node with an error edge continues the run down that branch', async () => {
    const { executionId } = await seedExecution(pool, errorPathIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await failNode(executionId, 'a');

    const states = await latestNodeStates(pool, executionId);
    const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
    expect(byId['h']).toBe('QUEUED');
    expect(byId['b']).toBe('SKIPPED');
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('RUNNING'); // the run is not over
  });

  test('the run reaches SUCCEEDED once the error branch finishes', async () => {
    const { executionId } = await seedExecution(pool, errorPathIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await failNode(executionId, 'a');
    await succeedNode(executionId, 'h');
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('SUCCEEDED');
  });

  test("policy 'continue' carries the run on down main with the error as output", async () => {
    const ir = errorPathIr();
    // Drop the error edge; the policy alone must keep the run alive.
    ir.edges = ir.edges.filter((e) => e.id !== 'e3');
    ir.nodes = ir.nodes.map((n) => (n.id === 'a' ? { ...n, settings: { onError: 'continue' as const } } : n));
    const { executionId } = await seedExecution(pool, ir);
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await failNode(executionId, 'a');

    const states = await latestNodeStates(pool, executionId);
    expect(states.find((s) => s.nodeId === 'b')?.status).toBe('QUEUED');
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('RUNNING');
  });

  test('a handled failure is still recorded FAILED on the node', async () => {
    // The database records what happened; the scheduler decides what it means.
    const { executionId } = await seedExecution(pool, errorPathIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await failNode(executionId, 'a');
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((s) => s.nodeId === 'a')?.status).toBe('FAILED');
  });

  test('the handler branch can read the failure as an expression value', async () => {
    const { executionId } = await seedExecution(pool, errorPathIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await failNode(executionId, 'a');
    const outputs = await nodeOutputs(pool, executionId);
    // Without this the branch that exists to handle the failure has nothing to read.
    expect(outputs['a']).toEqual({ error: { code: 'http_error', message: 'HTTP 500', retryable: false } });
  });
});

describe('handleNodeCompleted loops', () => {
  /** Succeeds the loop node itself, carrying the resolved items in its output. */
  async function succeedLoop(executionId: string, items: unknown[]) {
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['PENDING'], to: 'READY' });
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['READY', 'QUEUED'], to: 'QUEUED' });
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    const outputPort = items.length === 0 ? 'done' : 'item';
    await casNode(pool, {
      executionId,
      nodeId: 'lp',
      attempt: 1,
      from: ['RUNNING'],
      to: 'SUCCEEDED',
      patch: { outputJson: { items, count: items.length }, outputPort, completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId: 'lp', attempt: 1, status: 'SUCCEEDED', outputPort });
  }

  /** Drives an already-inserted instance row through to SUCCEEDED. */
  async function succeedInstance(executionId: string, nodeId: string) {
    await casNode(pool, { executionId, nodeId, attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId,
      attempt: 1,
      from: ['RUNNING'],
      to: 'SUCCEEDED',
      patch: { outputJson: {}, outputPort: 'main', completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId, attempt: 1, status: 'SUCCEEDED', outputPort: 'main' });
  }

  test('the authored body nodes are never seeded as runnable', async () => {
    // Only instances run. A PENDING row under the authored id would sit in the timeline
    // forever, claiming a node that is never going to execute.
    const { executionId } = await seedExecution(pool, loopIr());
    const states = await latestNodeStates(pool, executionId);
    expect(states.map((s) => s.nodeId).sort()).toEqual(['after', 'lp', 't']);
  });

  test('a succeeded loop queues one instance of the body entry per item', async () => {
    // Concurrency 2 so both iterations may start; the default of 1 is covered separately.
    const { executionId } = await seedExecution(pool, loopIr({ concurrency: 2 }));
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoop(executionId, ['x', 'y']);

    const states = await latestNodeStates(pool, executionId);
    const queued = states.filter((s) => s.status === 'QUEUED').map((s) => s.nodeId).sort();
    expect(queued).toEqual(['b1#0', 'b1#1']);
  });

  test('the join is seeded once every iteration is decided, and the run continues', async () => {
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoop(executionId, ['x']);
    await succeedInstance(executionId, 'b1#0');
    await succeedInstance(executionId, 'b2#0');

    const states = await latestNodeStates(pool, executionId);
    const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
    expect(byId['lp$join']).toBe('SUCCEEDED');
    expect(byId['after']).toBe('QUEUED');
  });

  test('the join waits while one iteration is still running', async () => {
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoop(executionId, ['x', 'y']);
    await succeedInstance(executionId, 'b1#0');
    await succeedInstance(executionId, 'b2#0');

    const states = await latestNodeStates(pool, executionId);
    const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
    expect(byId['lp$join']).toBeUndefined();
    // `after` was seeded with the execution, so it exists — it just must not have moved.
    expect(byId['after']).toBe('PENDING');
  });

  test('an empty loop skips the body entirely and fires done', async () => {
    // core.loop selects the done port for an empty list, so no join is ever created.
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoop(executionId, []);

    const states = await latestNodeStates(pool, executionId);
    const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
    expect(byId['after']).toBe('QUEUED');
    expect(states.some((s) => s.nodeId.startsWith('b1#'))).toBe(false);
    expect(byId['lp$join']).toBeUndefined();
  });

  test('a whole loop run reaches SUCCEEDED', async () => {
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoop(executionId, ['x', 'y']);
    for (const id of ['b1#0', 'b2#0', 'b1#1', 'b2#1']) await succeedInstance(executionId, id);
    await succeedNode(executionId, 'after');
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('SUCCEEDED');
  });
});

describe('handleNodeCompleted loop concurrency', () => {
  async function succeedLoopWith(executionId: string, items: unknown[]) {
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['PENDING'], to: 'READY' });
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['READY', 'QUEUED'], to: 'QUEUED' });
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId: 'lp',
      attempt: 1,
      from: ['RUNNING'],
      to: 'SUCCEEDED',
      patch: { outputJson: { items, count: items.length }, outputPort: 'item', completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId: 'lp', attempt: 1, status: 'SUCCEEDED', outputPort: 'item' });
  }

  async function finishInstance(executionId: string, nodeId: string) {
    await casNode(pool, { executionId, nodeId, attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId,
      attempt: 1,
      from: ['RUNNING'],
      to: 'SUCCEEDED',
      patch: { outputJson: {}, outputPort: 'main', completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId, attempt: 1, status: 'SUCCEEDED', outputPort: 'main' });
  }

  test('concurrency 2 keeps at most two iterations in flight', async () => {
    const { executionId } = await seedExecution(pool, loopIr({ concurrency: 2 }));
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoopWith(executionId, [1, 2, 3, 4, 5]);

    const states = await latestNodeStates(pool, executionId);
    const started = states.filter((s) => s.nodeId.startsWith('b1#'));
    expect(started).toHaveLength(2);
    expect(started.every((s) => s.status === 'QUEUED')).toBe(true);
  });

  test('the default of one runs iterations strictly one at a time', async () => {
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoopWith(executionId, [1, 2, 3]);
    const states = await latestNodeStates(pool, executionId);
    expect(states.filter((s) => s.nodeId.startsWith('b1#'))).toHaveLength(1);
  });

  test('finishing one iteration lets the next start', async () => {
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoopWith(executionId, [1, 2, 3]);
    await finishInstance(executionId, 'b1#0');
    await finishInstance(executionId, 'b2#0');

    const states = await latestNodeStates(pool, executionId);
    const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
    expect(byId['b1#1']).toBe('QUEUED');
    // The third iteration has not been materialised at all yet.
    expect(byId['b1#2']).toBeUndefined();
  });

  test('a second node of the same iteration does not spend a fresh slot', async () => {
    // b2#0 belongs to an iteration already under way; holding it back would deadlock the
    // loop at concurrency 1, because the slot is only released when the iteration finishes.
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoopWith(executionId, [1, 2]);
    await finishInstance(executionId, 'b1#0');

    const states = await latestNodeStates(pool, executionId);
    expect(states.find((s) => s.nodeId === 'b2#0')?.status).toBe('QUEUED');
  });

  test('every iteration eventually runs and the loop completes', async () => {
    const { executionId } = await seedExecution(pool, loopIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoopWith(executionId, [1, 2, 3]);
    for (let i = 0; i < 3; i += 1) {
      await finishInstance(executionId, `b1#${i}`);
      await finishInstance(executionId, `b2#${i}`);
    }
    const states = await latestNodeStates(pool, executionId);
    const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
    expect(byId['lp$join']).toBe('SUCCEEDED');
    expect(byId['after']).toBe('QUEUED');
  });
});

describe('adversarial review regressions', () => {
  async function succeedLoopNode(executionId: string, items: unknown[]) {
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['PENDING'], to: 'READY' });
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['READY', 'QUEUED'], to: 'QUEUED' });
    await casNode(pool, { executionId, nodeId: 'lp', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    const outputPort = items.length === 0 ? 'done' : 'item';
    await casNode(pool, {
      executionId,
      nodeId: 'lp',
      attempt: 1,
      from: ['RUNNING'],
      to: 'SUCCEEDED',
      patch: { outputJson: { items, count: items.length }, outputPort, completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId: 'lp', attempt: 1, status: 'SUCCEEDED', outputPort });
  }

  async function failNodeRaw(executionId: string, nodeId: string) {
    await casNode(pool, { executionId, nodeId, attempt: 1, from: ['PENDING', 'READY', 'QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId,
      attempt: 1,
      from: ['RUNNING'],
      to: 'FAILED',
      patch: { errorJson: { code: 'boom', retryable: false }, completedAt: true },
    });
    await handleNodeCompleted(deps, { executionId, nodeId, attempt: 1, status: 'FAILED' });
  }

  test('an iteration whose exit is skipped still completes the loop', async () => {
    // The last undecided instance is decided by a SKIP, which emits no node.completed. Seeding
    // the join from the pre-skip snapshot means nothing is dispatched again and the run hangs
    // until the watchdog times it out.
    const { executionId } = await seedExecution(pool, loopWithBranchIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedLoopNode(executionId, ['x']);

    await casNode(pool, { executionId, nodeId: 'b1#0', attempt: 1, from: ['QUEUED'], to: 'RUNNING' });
    await casNode(pool, {
      executionId,
      nodeId: 'b1#0',
      attempt: 1,
      from: ['RUNNING'],
      to: 'SUCCEEDED',
      patch: { outputJson: { result: false }, outputPort: 'false', completedAt: true },
    });
    await handleNodeCompleted(deps, {
      executionId,
      nodeId: 'b1#0',
      attempt: 1,
      status: 'SUCCEEDED',
      outputPort: 'false',
    });

    const states = await latestNodeStates(pool, executionId);
    const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
    expect(byId['b2#0']).toBe('SKIPPED');
    expect(byId['lp$join']).toBe('SUCCEEDED');
    expect(byId['after']).toBe('QUEUED');
  });

  test('a fatal failure does not dispatch a sibling that just became ready', async () => {
    // A fatal failure is "decided", so a fan-in node reads as ready. Queueing it in the same
    // transaction that fails the execution strands it QUEUED forever: the worker refuses to
    // run anything belonging to a terminal execution.
    const { executionId } = await seedExecution(pool, fanInIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await succeedNode(executionId, 'a');
    await failNodeRaw(executionId, 'b');

    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('FAILED');
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((s) => s.nodeId === 'z')?.status).not.toBe('QUEUED');
  });

  test('a failed run leaves no node stuck at PENDING', async () => {
    // The deleted FAILED short-circuit used to sweep every PENDING node to SKIPPED. Readiness
    // only skips nodes whose inbound edges are all inactive, so one sitting behind a
    // still-RUNNING sibling would stay PENDING on a finished execution forever.
    const { executionId } = await seedExecution(pool, parallelIr());
    await handleExecutionRequested(deps, { executionId });
    await succeedNode(executionId, 't');
    await casNode(pool, { executionId, nodeId: 'b', attempt: 1, from: ['PENDING', 'QUEUED'], to: 'RUNNING' });
    await failNodeRaw(executionId, 'a');

    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('FAILED');
    const states = await latestNodeStates(pool, executionId);
    expect(states.filter((s) => s.status === 'PENDING').map((s) => s.nodeId)).toEqual([]);
  });
});
