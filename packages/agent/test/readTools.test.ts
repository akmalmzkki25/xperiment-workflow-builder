import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, createUser, createWorkspaceWithOwner, runMigrations } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { freshRunState, guard, type AgentRunContext } from '../src/defineTool.js';
import {
  describeNodeType,
  getCredentialGuide,
  getWorkflowTool,
  listConnectionsTool,
  listWorkflowsTool,
} from '../src/tools/read.js';
import type { RequiredPermission } from '../src/permissions.js';

let pool: Pool;
const registry = createDefaultRegistry({ allowPrivateIps: true });

const ALL: RequiredPermission[] = ['workflow:read', 'workflow:write', 'connection:read', 'connection:write'];

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newWorkspace(): Promise<string> {
  const user = await createUser(pool, { email: `rt-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Read', userId: user!.id, actor: { actorKind: 'system' } });
  return ws.id;
}

function ctx(workspaceId: string, granted: RequiredPermission[] = ALL): AgentRunContext {
  return {
    pool,
    registry,
    workspaceId,
    userId: null,
    grantedPermissions: new Set(granted),
    runState: freshRunState(),
  };
}

describe('describe_node_type', () => {
  test('gives the model the exact version and ports, so it never has to guess', async () => {
    const ws = await newWorkspace();
    const out = await guard(describeNodeType, { type: 'telegram.sendMessage' }, ctx(ws));
    expect(out).toMatchObject({
      type: 'telegram.sendMessage',
      kind: 'action',
      requiresConnection: 'telegram',
      outputPorts: ['main'],
    });
    expect((out as { operationVersion: string }).operationVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('an unknown type is an error the model can recover from, not a throw', async () => {
    const ws = await newWorkspace();
    const out = await guard(describeNodeType, { type: 'telegram.sendMessagePlaceholder' }, ctx(ws));
    expect(out).toMatchObject({ error: 'unknown_node_type' });
    // Naming the near misses is what stops the model inventing a second wrong one.
    expect((out as { didYouMean: string[] }).didYouMean).toContain('telegram.sendMessage');
  });

  test('it carries the cross-field rules the JSON Schema cannot express', async () => {
    const ws = await newWorkspace();
    const out = await guard(describeNodeType, { type: 'whatsapp.sendMessage' }, ctx(ws));
    expect((out as { authoringNotes: string[] }).authoringNotes.join(' ')).toContain('templateName');
  });
});

describe('get_credential_guide', () => {
  test('answers the question the product could not answer before', async () => {
    const ws = await newWorkspace();
    const out = await guard(getCredentialGuide, { connectorKey: 'telegram' }, ctx(ws));
    const guide = out as { steps: { title: string; detail: string }[]; cautions: string[] };
    expect(JSON.stringify(guide.steps)).toContain('BotFather');
    expect(guide.cautions.join(' ').toLowerCase()).toContain('chat id');
  });

  test('an unknown connector says so rather than inventing steps', async () => {
    const ws = await newWorkspace();
    expect(await guard(getCredentialGuide, { connectorKey: 'carrier-pigeon' }, ctx(ws))).toMatchObject({
      error: 'unknown_connector',
    });
  });
});

describe('list_connections', () => {
  test('returns metadata and never anything shaped like a secret', async () => {
    const ws = await newWorkspace();
    await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'telegram','Toko bot','\\x00'::bytea,1)`,
      [ws],
    );
    const out = await guard(listConnectionsTool, {}, ctx(ws));
    const items = (out as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ connectorKey: 'telegram', name: 'Toko bot' });
    const text = JSON.stringify(items);
    expect(text).not.toContain('encrypted_payload');
    expect(text).not.toContain('payload');
  });

  test('another workspace never appears, whatever the model asks for', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'slack','Theirs','\\x00'::bytea,1)`,
      [theirs],
    );
    const out = await guard(listConnectionsTool, {}, ctx(mine));
    expect((out as { items: unknown[] }).items).toEqual([]);
  });

  test('a caller without connection:read is refused by name', async () => {
    const ws = await newWorkspace();
    expect(await guard(listConnectionsTool, {}, ctx(ws, ['workflow:read']))).toMatchObject({
      error: 'forbidden',
      permission: 'connection:read',
    });
  });
});

describe('get_workflow', () => {
  test('another workspace UUID is not_found, not data', async () => {
    // The two-argument getWorkflow is what makes this structural rather than a check
    // somebody has to remember.
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const wf = await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'theirs') RETURNING id`, [
      theirs,
    ]);
    const out = await guard(getWorkflowTool, { workflowId: (wf.rows[0] as { id: string }).id }, ctx(mine));
    expect(out).toMatchObject({ error: 'not_found' });
  });

  test('reads back the draft it was given', async () => {
    const ws = await newWorkspace();
    const wf = await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'mine') RETURNING id`, [ws]);
    const id = (wf.rows[0] as { id: string }).id;
    await pool.query(
      `INSERT INTO workflow_drafts (workflow_id, workspace_id, definition_json, revision)
       VALUES ($1,$2,'{"schemaVersion":"0.1"}'::jsonb,1)`,
      [id, ws],
    );
    const out = await guard(getWorkflowTool, { workflowId: id }, ctx(ws));
    expect(out).toMatchObject({ id, name: 'mine', draftRevision: 1 });
  });
});

describe('list_workflows', () => {
  test('finds one by a fragment of its name', async () => {
    const ws = await newWorkspace();
    for (const n of ['Pengingat makan siang', 'Rekap harian']) {
      await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,$2)`, [ws, n]);
    }
    const out = await guard(listWorkflowsTool, { query: 'makan' }, ctx(ws));
    expect((out as { items: { name: string }[] }).items.map((i) => i.name)).toEqual(['Pengingat makan siang']);
  });

  test('the search is case-insensitive, because people do not type titles back exactly', async () => {
    const ws = await newWorkspace();
    await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'Pengingat Makan')`, [ws]);
    const out = await guard(listWorkflowsTool, { query: 'MAKAN' }, ctx(ws));
    expect((out as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe('the fallbacks nobody exercises until they matter', () => {
  test('a connector with no docsUrl still returns a whole guide', async () => {
    const ws = await newWorkspace();
    const out = await guard(getCredentialGuide, { connectorKey: 'smtp' }, ctx(ws));
    expect((out as { steps: unknown[] }).steps.length).toBeGreaterThan(0);
    expect((out as { docsUrl?: string }).docsUrl).toBeUndefined();
  });

  test('list_connections filters to one connector when asked', async () => {
    const ws = await newWorkspace();
    for (const k of ['telegram', 'slack']) {
      await pool.query(
        `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
         VALUES ($1,$2,$3,'\\x00'::bytea,1)`,
        [ws, k, `${k} conn`],
      );
    }
    const out = await guard(listConnectionsTool, { connectorKey: 'slack' }, ctx(ws));
    expect((out as { items: { connectorKey: string }[] }).items.map((i) => i.connectorKey)).toEqual(['slack']);
  });

  test('list_workflows with no query returns the workspace, bounded by limit', async () => {
    const ws = await newWorkspace();
    for (const n of ['a', 'b', 'c']) await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,$2)`, [ws, n]);
    const out = await guard(listWorkflowsTool, { limit: 2 }, ctx(ws));
    expect((out as { items: unknown[] }).items).toHaveLength(2);
  });

  test('a workflow with no draft row still reads back', async () => {
    const ws = await newWorkspace();
    const wf = await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'bare') RETURNING id`, [ws]);
    const out = await guard(getWorkflowTool, { workflowId: (wf.rows[0] as { id: string }).id }, ctx(ws));
    expect(out).toMatchObject({ name: 'bare', definition: null });
  });

  test('a node type with no authoring notes returns an empty list, not undefined', async () => {
    const ws = await newWorkspace();
    const out = await guard(describeNodeType, { type: 'core.transform' }, ctx(ws));
    expect((out as { authoringNotes: unknown[] }).authoringNotes).toEqual([]);
  });
});

describe('no read tool has a workspace-shaped input', () => {
  test('the model cannot name a tenant, because there is no field for it', () => {
    // Structurally absent, not validated away: no token sequence reaches it.
    for (const tool of [describeNodeType, getCredentialGuide, listConnectionsTool, getWorkflowTool, listWorkflowsTool]) {
      const shape = Object.keys((tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {});
      for (const key of shape) expect(key, `${tool.id}.${key}`).not.toMatch(/workspace|tenant|org/i);
    }
  });
});
