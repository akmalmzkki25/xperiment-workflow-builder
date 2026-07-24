import { createDefaultRegistry } from '@xperiment/connectors';
import {
  createConnection,
  DEFAULT_WORKSPACE_ID,
  createPool,
  deriveTriggerKey,
  encryptSecret,
  latestNodeStates,
  runMigrations,
  succeededOutputs,
} from '@xperiment/db';
import type { WorkflowIR } from '@xperiment/ir';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runNodeTask, type WorkerDeps } from '../src/runTask.js';
import { queueNode, seedExecution, truncateAll } from './helpers.js';

let pool: Pool;
let deps: WorkerDeps;
const credentialsKey = deriveTriggerKey('xperiment-dev-credentials-secret-change-me');
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://xperiment:xperiment@localhost:5432/xperiment';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  deps = {
    pool,
    registry: createDefaultRegistry({ allowPrivateIps: true }),
    workerId: 'w-test',
    credentialsKey,
    log: () => {},
  };
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query(`TRUNCATE connections CASCADE`);
});

function pgIr(connectionRef?: string): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_pg', name: 'PG' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'q',
        kind: 'action',
        type: 'postgres.query',
        operationVersion: '0.1.0',
        parameters: { sql: 'SELECT 41 + 1 AS answer' },
        ...(connectionRef ? { connectionRef } : {}),
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'q', port: 'input' } }],
  };
}

async function runThrough(ir: WorkflowIR): Promise<string> {
  const { executionId } = await seedExecution(pool, ir, {});
  await queueNode(pool, executionId, 't');
  await runNodeTask(deps, { executionId, nodeId: 't', attempt: 1 });
  await queueNode(pool, executionId, 'q');
  await runNodeTask(deps, { executionId, nodeId: 'q', attempt: 1 });
  return executionId;
}

describe('worker connection resolution', () => {
  test('decrypts and passes the connection; query runs; input_json stays secret-free', async () => {
    const conn = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'postgres',
      name: 'DB',
      encryptedPayload: encryptSecret(JSON.stringify({ connectionString: DB_URL }), credentialsKey),
    });
    const executionId = await runThrough(pgIr(conn.id));
    const outputs = await succeededOutputs(pool, executionId);
    expect(outputs['q']).toEqual({ rows: [{ answer: 42 }], rowCount: 1 });
    const input = await pool.query(
      `SELECT input_json::text AS t FROM execution_nodes WHERE execution_id = $1 AND node_id = 'q'`,
      [executionId],
    );
    expect((input.rows[0] as { t: string }).t).not.toContain('xperiment:xperiment'); // no conn string stored
  });

  test('missing connectionRef fails non-retryably with connection_required', async () => {
    const executionId = await runThrough(pgIr());
    const states = await latestNodeStates(pool, executionId);
    expect(states.find((n) => n.nodeId === 'q')?.status).toBe('FAILED');
    const row = await pool.query(
      `SELECT error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = 'q'`,
      [executionId],
    );
    expect((row.rows[0] as { error_json: { code: string } }).error_json.code).toBe('connection_required');
  });

  test('unknown connectionRef fails with connection_not_found', async () => {
    const executionId = await runThrough(pgIr('33333333-3333-3333-3333-333333333333'));
    const row = await pool.query(
      `SELECT error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = 'q'`,
      [executionId],
    );
    expect((row.rows[0] as { error_json: { code: string } }).error_json.code).toBe('connection_not_found');
  });

  test('tampered ciphertext fails with connection_invalid', async () => {
    const good = encryptSecret(JSON.stringify({ connectionString: DB_URL }), credentialsKey);
    const tampered = Buffer.from(good);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    const conn = await createConnection(pool, { workspaceId: DEFAULT_WORKSPACE_ID, connectorKey: 'postgres', name: 'Bad', encryptedPayload: tampered });
    const executionId = await runThrough(pgIr(conn.id));
    const row = await pool.query(
      `SELECT error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = 'q'`,
      [executionId],
    );
    expect((row.rows[0] as { error_json: { code: string } }).error_json.code).toBe('connection_invalid');
  });
});
