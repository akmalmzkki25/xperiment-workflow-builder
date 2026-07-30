import { createDefaultRegistry } from '@xperiment/connectors';
import { randomUUID } from 'node:crypto';
import {
  createConnection,
  createSecretVault,
  DEFAULT_LOCAL_KEK_MASTER,
  createWorkspaceKeyring,
  DEFAULT_WORKSPACE_ID,
  createPool,
  deriveLegacyKey,
  encryptSecret,
  latestNodeStates,
  localKeyProvider,
  runMigrations,
  succeededOutputs,
  type SecretVault,
} from '@xperiment/db';
import type { WorkflowIR } from '@xperiment/ir';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runNodeTask, type WorkerDeps } from '../src/runTask.js';
import { queueNode, seedExecution, truncateAll } from './helpers.js';

let pool: Pool;
let deps: WorkerDeps;
let credentialsVault: SecretVault;
const credentialsKey = deriveLegacyKey('xperiment-dev-credentials-secret-change-me');
const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://postgres:dev_password_change_me@localhost:5432/xperiment';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  credentialsVault = createSecretVault({
    keyring: createWorkspaceKeyring({ pool, provider: localKeyProvider(DEFAULT_LOCAL_KEK_MASTER) }),
    legacyKey: credentialsKey,
  });
  deps = {
    pool,
    registry: createDefaultRegistry({ allowPrivateIps: true }),
    workerId: 'w-test',
    credentialsVault,
    log: () => {},
  };
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query(`TRUNCATE connections, audit_events CASCADE`);
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

describe('worker connection resolution: envelope encryption, audit and tenant scope', () => {
  async function errorCode(executionId: string): Promise<string | undefined> {
    const row = await pool.query<{ error_json: { code: string } | null }>(
      `SELECT error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = 'q'`,
      [executionId],
    );
    return row.rows[0]?.error_json?.code;
  }

  async function readUseRows(): Promise<{ actor_kind: string; metadata: Record<string, unknown> }[]> {
    const r = await pool.query<{ actor_kind: string; metadata: Record<string, unknown> }>(
      `SELECT actor_kind, metadata FROM audit_events WHERE action = 'credential.read_use' ORDER BY id`,
    );
    return r.rows;
  }

  test('resolves an envelope-encrypted connection and audits the read', async () => {
    const sealed = await credentialsVault.encrypt(DEFAULT_WORKSPACE_ID, JSON.stringify({ connectionString: DB_URL }));
    const conn = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'postgres',
      name: 'Enveloped',
      encryptedPayload: sealed.blob,
      encVersion: sealed.encVersion,
    });
    const executionId = await runThrough(pgIr(conn.id));
    expect((await succeededOutputs(pool, executionId))['q']).toEqual({ rows: [{ answer: 42 }], rowCount: 1 });
    const rows = await readUseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_kind).toBe('system');
    expect(rows[0]!.metadata).toMatchObject({ executionId, nodeId: 'q', connectorKey: 'postgres' });
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('dev_password_change_me');
  });

  test('a LEGACY connection belonging to another workspace is not resolved', async () => {
    // The defect this closes: runTask omitted the optional workspaceId, so a published IR
    // naming any connection UUID resolved it. A legacy (v0) blob has no workspace binding,
    // so crypto alone would happily decrypt it — only the filter stops this, which makes
    // this the case that actually proves the fix.
    const foreign = randomUUID();
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'other')`, [foreign]);
    const conn = await createConnection(pool, {
      workspaceId: foreign,
      connectorKey: 'postgres',
      name: 'NotYours',
      encryptedPayload: encryptSecret(JSON.stringify({ connectionString: DB_URL }), credentialsKey),
    });
    const executionId = await runThrough(pgIr(conn.id));
    expect(await errorCode(executionId)).toBe('connection_not_found');
    expect(await readUseRows()).toHaveLength(0);
  });

  test('an ENVELOPE connection belonging to another workspace is not resolved either', async () => {
    const foreign = randomUUID();
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'other2')`, [foreign]);
    const sealed = await credentialsVault.encrypt(foreign, JSON.stringify({ connectionString: DB_URL }));
    const conn = await createConnection(pool, {
      workspaceId: foreign,
      connectorKey: 'postgres',
      name: 'NotYoursV1',
      encryptedPayload: sealed.blob,
      encVersion: sealed.encVersion,
    });
    const executionId = await runThrough(pgIr(conn.id));
    // connection_not_found, not connection_invalid: the lookup must miss, rather than
    // finding the row and then failing to decrypt it.
    expect(await errorCode(executionId)).toBe('connection_not_found');
    expect(await readUseRows()).toHaveLength(0);
  });

  test('a failed decrypt is not audited as a read-use', async () => {
    const sealed = await credentialsVault.encrypt(DEFAULT_WORKSPACE_ID, JSON.stringify({ connectionString: DB_URL }));
    const tampered = Buffer.from(sealed.blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    const conn = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'postgres',
      name: 'Tampered',
      encryptedPayload: tampered,
      encVersion: sealed.encVersion,
    });
    const executionId = await runThrough(pgIr(conn.id));
    expect(await errorCode(executionId)).toBe('connection_invalid');
    expect(await readUseRows()).toHaveLength(0); // nothing was read
  });
});

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
    expect((input.rows[0] as { t: string }).t).not.toContain('dev_password_change_me'); // no conn string stored
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
