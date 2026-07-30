import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, DEFAULT_WORKSPACE_ID, decryptSecret, deriveLegacyKey, encryptSecret, runMigrations } from '../src/index.js';
import {
  countPublishedRefs,
  createConnection,
  deleteConnection,
  getConnectionWithPayload,
  listConnections,
} from '../src/repos/connections.js';
import { createVersion, createWorkflow } from '../src/repos/workflows.js';

let pool: Pool;
const key = deriveLegacyKey('xperiment-dev-credentials-secret-change-me');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE connections, workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

describe('connections repo', () => {
  test('stores encrypted payload at rest and round-trips via decrypt', async () => {
    const payload = JSON.stringify({ botToken: 'tok-123' });
    const row = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'telegram',
      name: 'Bot',
      encryptedPayload: encryptSecret(payload, key),
    });
    expect(row.connectorKey).toBe('telegram');
    const raw = await pool.query(`SELECT encrypted_payload FROM connections WHERE id = $1`, [row.id]);
    const stored = (raw.rows[0] as { encrypted_payload: Buffer }).encrypted_payload;
    expect(stored.toString('utf8')).not.toContain('tok-123'); // encrypted at rest
    const withPayload = await getConnectionWithPayload(pool, row.id);
    expect(decryptSecret(withPayload!.encryptedPayload, key)).toBe(payload);
  });

  test('list omits payloads; delete removes; missing lookups are null/false', async () => {
    const row = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'openai',
      name: 'AI',
      encryptedPayload: encryptSecret('{}', key),
    });
    const list = await listConnections(pool, DEFAULT_WORKSPACE_ID);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!)).not.toContain('encryptedPayload');
    expect(await deleteConnection(pool, row.id, DEFAULT_WORKSPACE_ID)).toBe(true);
    expect(await deleteConnection(pool, row.id, DEFAULT_WORKSPACE_ID)).toBe(false);
    expect(await getConnectionWithPayload(pool, row.id)).toBeNull();
  });

  test('defaults to the legacy version and reports it, with the workspace, on read', async () => {
    const row = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'telegram',
      name: 'Legacy',
      encryptedPayload: encryptSecret('{}', key),
    });
    const read = await getConnectionWithPayload(pool, row.id);
    expect(read!.encVersion).toBe(0);
    expect(read!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  test('an explicit version is stored and read back', async () => {
    const row = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'telegram',
      name: 'Enveloped',
      encryptedPayload: Buffer.from([1, 2, 3]),
      encVersion: 1,
    });
    expect((await getConnectionWithPayload(pool, row.id))!.encVersion).toBe(1);
  });

  test('countPublishedRefs finds connectionRef inside published versions', async () => {
    const conn = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'postgres',
      name: 'DB',
      encryptedPayload: encryptSecret('{}', key),
    });
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'W' });
    await createVersion(pool, {
      workflowId: wf.id,
      definition: { nodes: [{ id: 'q', connectionRef: conn.id }] },
      hash: 'h',
    });
    expect(await countPublishedRefs(pool, conn.id)).toBe(1);
    expect(await countPublishedRefs(pool, '00000000-0000-0000-0000-0000000000ff')).toBe(0);
  });
});
