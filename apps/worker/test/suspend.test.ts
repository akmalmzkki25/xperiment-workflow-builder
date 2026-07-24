import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, deriveTriggerKey, latestNodeStates, runMigrations, waitsForExecution } from '@xperiment/db';
import type { WorkflowIR } from '@xperiment/ir';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runNodeTask, type WorkerDeps } from '../src/runTask.js';
import { queueNode, seedExecution, truncateAll } from './helpers.js';

let pool: Pool;
let deps: WorkerDeps;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  deps = {
    pool,
    registry: createDefaultRegistry({ allowPrivateIps: true }),
    workerId: 'w-test',
    credentialsKey: deriveTriggerKey('xperiment-dev-credentials-secret-change-me'),
    log: () => {},
  };
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

function delayIr(): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_delay', name: 'Delay' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      { id: 'wait', kind: 'logic', type: 'core.delay', operationVersion: '0.1.0', parameters: { durationMs: 60000 } },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'wait', port: 'input' } }],
  };
}

describe('worker suspend path', () => {
  test('a delay node suspends into WAITING with an open timer wait and emits no completion', async () => {
    const { executionId } = await seedExecution(pool, delayIr(), {});
    await queueNode(pool, executionId, 'wait');
    await runNodeTask(deps, { executionId, nodeId: 'wait', attempt: 1 });

    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 'wait')?.status).toBe('WAITING');

    const waits = await waitsForExecution(pool, executionId);
    expect(waits).toHaveLength(1);
    expect(waits[0]!.kind).toBe('timer');
    expect(waits[0]!.status).toBe('open');
    expect(new Date(waits[0]!.resumeAt!).getTime()).toBeGreaterThan(Date.now());

    const outbox = await pool.query(
      `SELECT count(*)::int AS n FROM task_outbox WHERE event_type = 'node.completed' AND payload_json->>'nodeId' = 'wait'`,
    );
    expect((outbox.rows[0] as { n: number }).n).toBe(0);
  });
});
