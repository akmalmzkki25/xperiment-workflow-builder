import { createServer, type Server } from 'node:http';
import { createDefaultRegistry } from '@xperiment/connectors';
import {
  createPool,
  deriveLegacyKey,
  fetchUnpublished,
  latestNodeStates,
  runMigrations,
  succeededOutputs,
} from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runNodeTask, type WorkerDeps } from '../src/runTask.js';
import { linearIr, queueNode, seedExecution, truncateAll, type WorkflowIR } from './helpers.js';

let pool: Pool;
let deps: WorkerDeps;
let server: Server;
let stubUrl: string;
let responses: number[] = [];

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  deps = {
    pool,
    registry: createDefaultRegistry({ allowPrivateIps: true }),
    workerId: 'w-test',
    credentialsKey: deriveLegacyKey('xperiment-dev-credentials-secret-change-me'),
    log: () => {},
  };
  server = createServer((req, res) => {
    const status = responses.shift() ?? 200;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: status < 400 }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  stubUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
beforeEach(async () => {
  responses = [];
  await truncateAll(pool);
});

function httpIr(): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_http', name: 'Http' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'call',
        kind: 'action',
        type: 'http.request',
        operationVersion: '0.1.0',
        parameters: { method: 'POST', url: `${stubUrl}/x`, body: { name: '{{ trigger.body.name }}' } },
        settings: { timeoutMs: 2000, retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50 } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'call', port: 'input' } }],
  };
}

describe('runNodeTask', () => {
  test('trigger node emits the trigger payload and a SUCCEEDED completion', async () => {
    const { executionId } = await seedExecution(pool, linearIr(), { name: 'Budi' });
    await queueNode(pool, executionId, 't');
    await pool.query(`TRUNCATE task_outbox`);
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });

    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 't')?.status).toBe('SUCCEEDED');
    const outputs = await succeededOutputs(pool, executionId);
    expect(outputs['t']).toEqual({ name: 'Budi' });
    const outbox = await fetchUnpublished(pool, 10);
    expect(outbox[0]!.eventType).toBe('node.completed');
    expect(outbox[0]!.payload).toMatchObject({
      executionId,
      nodeId: 't',
      attempt: 1,
      status: 'SUCCEEDED',
      outputPort: 'main',
    });
  });

  test('transform resolves expressions against prior outputs', async () => {
    const { executionId } = await seedExecution(pool, linearIr(), { name: 'Budi' });
    await queueNode(pool, executionId, 't');
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });
    await queueNode(pool, executionId, 'greet');
    await runNodeTask(deps, { executionId, nodeId: 'greet', attempt: 1 });
    const outputs = await succeededOutputs(pool, executionId);
    expect(outputs['greet']).toEqual({ msg: 'Halo Budi' });
  });

  test('retryable http failure becomes RETRY_SCHEDULED with backoff delay', async () => {
    responses = [503];
    const { executionId } = await seedExecution(pool, httpIr(), { name: 'Budi' });
    await queueNode(pool, executionId, 't');
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });
    await queueNode(pool, executionId, 'call');
    await pool.query(`TRUNCATE task_outbox`);
    await runNodeTask(deps, { executionId, nodeId: 'call', attempt: 1 });

    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 'call')?.status).toBe('RETRY_SCHEDULED');
    const outbox = await fetchUnpublished(pool, 10);
    const completed = outbox.find((o) => o.eventType === 'node.completed')!;
    expect(completed.payload).toMatchObject({ nodeId: 'call', attempt: 1, status: 'RETRY_SCHEDULED' });
    expect((completed.payload as { delayMs: number }).delayMs).toBeGreaterThanOrEqual(5);
    const row = await pool.query(
      `SELECT error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = 'call' AND attempt = 1`,
      [executionId],
    );
    expect((row.rows[0] as { error_json: { code: string } }).error_json.code).toBe('http_error');
  });

  test('non-retryable http failure becomes FAILED', async () => {
    responses = [404];
    const { executionId } = await seedExecution(pool, httpIr(), { name: 'Budi' });
    await queueNode(pool, executionId, 't');
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });
    await queueNode(pool, executionId, 'call');
    await runNodeTask(deps, { executionId, nodeId: 'call', attempt: 1 });
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 'call')?.status).toBe('FAILED');
  });

  test('expression evaluation error fails without retry', async () => {
    const ir = linearIr();
    ir.nodes[1]!.parameters = { fields: { bad: '{{ lower(trigger.body.total) }}' } };
    const { executionId } = await seedExecution(pool, ir, { total: 5 });
    await queueNode(pool, executionId, 't');
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });
    await queueNode(pool, executionId, 'greet');
    await runNodeTask(deps, { executionId, nodeId: 'greet', attempt: 1 });
    const row = await pool.query(
      `SELECT status, error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = 'greet'`,
      [executionId],
    );
    expect((row.rows[0] as { status: string }).status).toBe('FAILED');
    expect((row.rows[0] as { error_json: { code: string } }).error_json.code).toBe('expression_error');
  });

  test('duplicate delivery is a no-op (CAS claim fails, no extra outbox row)', async () => {
    const { executionId } = await seedExecution(pool, linearIr(), { name: 'Budi' });
    await queueNode(pool, executionId, 't');
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });
    const before = (await fetchUnpublished(pool, 20)).length;
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 }); // redelivery
    const after = (await fetchUnpublished(pool, 20)).length;
    expect(after).toBe(before);
  });

  test('skips work when the execution is already terminal', async () => {
    const { executionId } = await seedExecution(pool, linearIr(), { name: 'Budi' });
    await pool.query(`UPDATE executions SET status = 'TIMED_OUT' WHERE id = $1`, [executionId]);
    await queueNode(pool, executionId, 't');
    await pool.query(`TRUNCATE task_outbox`);
    await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });
    expect(await fetchUnpublished(pool, 10)).toHaveLength(0);
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 't')?.status).toBe('QUEUED'); // untouched
  });
});
