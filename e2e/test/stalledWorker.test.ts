import type { ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  api,
  API_URL,
  createPublishedWorkflow,
  killPortOwners,
  killService,
  prepareDatabase,
  spawnService,
  startStubServer,
  waitForHealthz,
  waitForPortsFree,
  waitForTerminal,
  type StubServer,
} from './helpers.js';

let pool: Pool;
let stub: StubServer;
let apiProc: ChildProcess;
let orchProc: ChildProcess;
let workerProc: ChildProcess;

function slowIr(stubUrl: string): unknown {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_slow', name: 'Slow' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'slow',
        kind: 'action',
        type: 'http.request',
        operationVersion: '0.1.0',
        parameters: { method: 'GET', url: `${stubUrl}/slow` },
        settings: { timeoutMs: 20000 },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'slow', port: 'input' } }],
  };
}

beforeAll(async () => {
  pool = await prepareDatabase();
  stub = await startStubServer();
  await waitForPortsFree();
  apiProc = spawnService('@xperiment/api');
  orchProc = spawnService('@xperiment/orchestrator');
  workerProc = spawnService('@xperiment/worker');
  await waitForHealthz(`${API_URL}/v1/healthz`);
  await waitForHealthz('http://127.0.0.1:3101');
  await waitForHealthz('http://127.0.0.1:3102');
}, 120000);

afterAll(async () => {
  for (const p of [apiProc, orchProc, workerProc]) killService(p);
  await killPortOwners();
  await stub.close();
  await pool.end();
});

describe('worker crash recovery', () => {
  test('killing the worker mid-task leaves at most one committed result; restarted worker completes new work', async () => {
    const wfId = await createPublishedWorkflow(slowIr(stub.url));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {});

    // Wait until the slow node is RUNNING, then kill the worker mid-flight.
    const deadline = Date.now() + 20000;
    for (;;) {
      const { body } = await api<{ nodes: { nodeId: string; status: string }[] }>(
        'GET',
        `/v1/executions/${exec.body.executionId}`,
      );
      if (body.nodes.some((n) => n.nodeId === 'slow' && n.status === 'RUNNING')) break;
      if (Date.now() > deadline) throw new Error('slow node never started');
      await new Promise((r) => setTimeout(r, 200));
    }
    killService(workerProc);
    await new Promise((r) => setTimeout(r, 1500));
    workerProc = spawnService('@xperiment/worker');
    await waitForHealthz('http://127.0.0.1:3102');

    // The invariant that matters for at-least-once + CAS: no duplicate committed
    // SUCCEEDED rows for the same (node, attempt), even across redelivery.
    await new Promise((r) => setTimeout(r, 5000));
    const rows = await pool.query(
      `SELECT count(*)::int AS c FROM execution_nodes
       WHERE execution_id = $1 AND node_id = 'slow' AND status = 'SUCCEEDED'`,
      [exec.body.executionId],
    );
    expect((rows.rows[0] as { c: number }).c).toBeLessThanOrEqual(1);

    // A fresh execution on the restarted worker completes normally end-to-end.
    const exec2 = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {});
    const detail2 = await waitForTerminal(exec2.body.executionId, 40000);
    expect(detail2.execution.status).toBe('SUCCEEDED');
  }, 120000);
});
