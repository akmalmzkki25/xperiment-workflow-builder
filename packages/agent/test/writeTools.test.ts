import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, createUser, createWorkspaceWithOwner, getDraft, runMigrations, updateDraft } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { freshRunState, guard, type AgentRunContext } from '../src/defineTool.js';
import type { RequiredPermission } from '../src/permissions.js';
import {
  createWorkflowTool,
  putDraft,
  requestCredential,
  setNodeConnection,
  validateWorkflowTool,
} from '../src/tools/write.js';

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
  const user = await createUser(pool, { email: `wt-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Write', userId: user!.id, actor: { actorKind: 'system' } });
  return ws.id;
}

function ctx(workspaceId: string, granted: RequiredPermission[] = ALL): AgentRunContext {
  return { pool, registry, workspaceId, userId: null, grantedPermissions: new Set(granted), runState: freshRunState() };
}

async function connection(workspaceId: string, connectorKey: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
     VALUES ($1,$2,$3,'\\x00'::bytea,1) RETURNING id`,
    [workspaceId, connectorKey, `${connectorKey} conn`],
  );
  return (r.rows[0] as { id: string }).id;
}

/** The reported case: a schedule that sends a Telegram message. */
function reminderIr(connectionRef?: string) {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_reminder', name: 'Pengingat makan' },
    entrypoints: ['at_noon'],
    nodes: [
      {
        id: 'at_noon',
        kind: 'trigger',
        type: 'schedule.trigger',
        operationVersion: '0.1.0',
        parameters: { cron: '0 12 * * *', timezone: 'Asia/Jakarta' },
      },
      {
        id: 'notify',
        kind: 'action',
        type: 'telegram.sendMessage',
        operationVersion: '0.1.0',
        parameters: { chatId: '123', text: 'Waktunya makan' },
        ...(connectionRef ? { connectionRef } : {}),
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'at_noon', port: 'main' }, to: { nodeId: 'notify', port: 'input' } }],
    metadata: { layout: { at_noon: { x: 80, y: 120 }, notify: { x: 420, y: 120 } } },
  };
}

async function makeWorkflow(c: AgentRunContext, name = 'Pengingat makan'): Promise<string> {
  const out = await guard(createWorkflowTool, { name }, c);
  return (out as { workflowId: string }).workflowId;
}

describe('create_workflow', () => {
  test('creates one and remembers it, so a second call cannot litter the workspace', async () => {
    const c = ctx(await newWorkspace());
    const first = await guard(createWorkflowTool, { name: 'Pengingat makan' }, c);
    const second = await guard(createWorkflowTool, { name: 'Another one' }, c);
    expect(second).toMatchObject({ error: 'already_created', workflowId: (first as { workflowId: string }).workflowId });
  });
});

describe('put_draft', () => {
  test('a telegram node with no connection saves, and says exactly what is missing', async () => {
    // THE REGRESSION TEST. The old builder, asked for this, emitted a core.transform
    // named telegram_message_placeholder because the prompt forbade the only correct
    // node. The right node with an unset connectionRef is a good outcome: it saves, it
    // reports connection_required on the node, and it names the connector in words.
    const c = ctx(await newWorkspace());
    const workflowId = await makeWorkflow(c);
    const out = (await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c)) as {
      revision: number;
      valid: boolean;
      findings: { code: string; nodeId?: string }[];
      missingConnections: { nodeId: string; connectorKey: string; connectorDisplayName: string }[];
    };

    expect(out.revision).toBe(2);
    expect(out.valid).toBe(false);
    expect(out.findings.find((f) => f.code === 'connection_required')?.nodeId).toBe('notify');
    expect(out.missingConnections).toEqual([
      { nodeId: 'notify', connectorKey: 'telegram', connectorDisplayName: 'Telegram', existingConnectionIds: [] },
    ]);

    // And the node that was saved is the right one, not a stand-in.
    const draft = await getDraft(pool, workflowId);
    const nodes = (draft!.definition as { nodes: { type: string }[] }).nodes;
    expect(nodes[1]!.type).toBe('telegram.sendMessage');
    expect(JSON.stringify(nodes)).not.toMatch(/placeholder|todo|stub/i);
  });

  test('with the connection wired it validates clean', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    const connId = await connection(ws, 'telegram');
    const out = (await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr(connId)) }, c)) as {
      valid: boolean;
      missingConnections: unknown[];
    };
    expect(out.valid).toBe(true);
    expect(out.missingConnections).toEqual([]);
  });

  test('it names an existing connection of the right connector, so the model can wire it', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    const connId = await connection(ws, 'telegram');
    const out = (await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c)) as {
      missingConnections: { existingConnectionIds: string[] }[];
    };
    expect(out.missingConnections[0]!.existingConnectionIds).toEqual([connId]);
  });

  test('a definition that is not JSON is a clean error, not a crash', async () => {
    // The spike decision: definition arrives as a string, because node.parameters is an
    // open record that strict tool schemas reject and the provider is user-configurable.
    const c = ctx(await newWorkspace());
    const workflowId = await makeWorkflow(c);
    expect(await guard(putDraft, { workflowId, definition: '{not json' }, c)).toMatchObject({ error: 'not_json' });
  });

  test('a JSON document that is not a workflow reports why', async () => {
    const c = ctx(await newWorkspace());
    const workflowId = await makeWorkflow(c);
    const out = await guard(putDraft, { workflowId, definition: '{"nodes":"nope"}' }, c);
    expect(out).toMatchObject({ error: 'not_a_workflow' });
  });

  test('another workspace cannot be written to', async () => {
    const mine = ctx(await newWorkspace());
    const theirs = ctx(await newWorkspace());
    const foreign = await makeWorkflow(theirs);
    expect(await guard(putDraft, { workflowId: foreign, definition: JSON.stringify(reminderIr()) }, mine)).toMatchObject(
      { error: 'not_found' },
    );
  });

  test('a canvas edited underneath is a revision conflict, not a silent overwrite', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c);
    // Somebody saves from the editor between the tool's read and its write.
    const before = await getDraft(pool, workflowId);
    await updateDraft(pool, { workflowId, definition: { edited: true }, expectedRevision: before!.revision });
    const out = await guard(
      putDraft,
      { workflowId, definition: JSON.stringify(reminderIr()), expectedRevision: before!.revision },
      c,
    );
    expect(out).toMatchObject({ error: 'revision_conflict' });
  });
});

describe('set_node_connection', () => {
  test('refuses a credential for the wrong service and leaves the draft untouched', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c);
    const slack = await connection(ws, 'slack');
    const before = await getDraft(pool, workflowId);

    const out = await guard(setNodeConnection, { workflowId, nodeId: 'notify', connectionId: slack }, c);
    expect(out).toMatchObject({ error: 'connection_wrong_type', expected: 'telegram', actual: 'slack' });

    const after = await getDraft(pool, workflowId);
    expect(after!.revision).toBe(before!.revision);
    expect(after!.definition).toEqual(before!.definition);
  });

  test('another workspace connection id is not_found', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c);
    const foreign = await connection(await newWorkspace(), 'telegram');
    expect(await guard(setNodeConnection, { workflowId, nodeId: 'notify', connectionId: foreign }, c)).toMatchObject({
      error: 'not_found',
    });
  });

  test('wires the right one and the draft then validates', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c);
    const tg = await connection(ws, 'telegram');
    const out = (await guard(setNodeConnection, { workflowId, nodeId: 'notify', connectionId: tg }, c)) as {
      ok: boolean;
      valid: boolean;
    };
    expect(out).toMatchObject({ ok: true, valid: true });
    const draft = await getDraft(pool, workflowId);
    expect((draft!.definition as { nodes: { connectionRef?: string }[] }).nodes[1]!.connectionRef).toBe(tg);
  });

  test('a node that needs no connection is refused rather than given a stray reference', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c);
    const tg = await connection(ws, 'telegram');
    expect(await guard(setNodeConnection, { workflowId, nodeId: 'at_noon', connectionId: tg }, c)).toMatchObject({
      error: 'node_needs_no_connection',
    });
  });

  test('an unknown node id says so', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c);
    const tg = await connection(ws, 'telegram');
    expect(await guard(setNodeConnection, { workflowId, nodeId: 'ghost', connectionId: tg }, c)).toMatchObject({
      error: 'unknown_node',
    });
  });
});

describe('validate_workflow', () => {
  test('validates what is STORED, so the model cannot check one document and save another', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    const workflowId = await makeWorkflow(c);
    await guard(putDraft, { workflowId, definition: JSON.stringify(reminderIr()) }, c);
    const out = (await guard(validateWorkflowTool, { workflowId }, c)) as {
      valid: boolean;
      missingConnections: { connectorKey: string }[];
    };
    expect(out.valid).toBe(false);
    expect(out.missingConnections.map((m) => m.connectorKey)).toEqual(['telegram']);
  });
});

describe('request_credential', () => {
  test('has no input field capable of carrying a secret', () => {
    // The whole point of the handoff. A schema with a `token` field is an invitation.
    // `connectorKey` names which connector, not a credential. What must not exist is a
    // field that could hold the VALUE.
    const shape = Object.keys((requestCredential.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
    for (const key of shape) {
      expect(key, key).not.toMatch(/token|secret|password|credential|apikey|api_key|value|payload/i);
    }
    expect(shape).toContain('connectorKey');
  });

  test('records the request and hands back a form url, creating nothing', async () => {
    const ws = await newWorkspace();
    const c = ctx(ws);
    c.conversationId = (
      await pool.query(`INSERT INTO agent_conversations (workspace_id) VALUES ($1) RETURNING id`, [ws])
    ).rows[0]!.id as string;
    const before = await pool.query(`SELECT count(*)::int AS n FROM connections WHERE workspace_id = $1`, [ws]);
    const out = (await guard(
      requestCredential,
      { connectorKey: 'telegram', reason: 'to send the reminder', nodeId: 'notify' },
      c,
    )) as { formUrl: string; guide: { steps: unknown[] } };
    expect(out.formUrl).toContain('connector=telegram');
    expect(out.guide.steps.length).toBeGreaterThan(0);
    const after = await pool.query(`SELECT count(*)::int AS n FROM connections WHERE workspace_id = $1`, [ws]);
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);
  });

  test('an operator who cannot add credentials is told who can', async () => {
    const c = ctx(await newWorkspace(), ['workflow:read', 'workflow:write']);
    const out = await guard(requestCredential, { connectorKey: 'telegram', reason: 'x' }, c);
    expect(out).toMatchObject({ error: 'forbidden', permission: 'connection:write' });
    expect((out as { message: string }).message.toLowerCase()).toContain('admin');
  });
});

describe('no write tool has a workspace-shaped input', () => {
  test('the model cannot name a tenant', () => {
    for (const tool of [createWorkflowTool, putDraft, setNodeConnection, validateWorkflowTool, requestCredential]) {
      const shape = Object.keys((tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {});
      for (const key of shape) expect(key, `${tool.id}.${key}`).not.toMatch(/workspace|tenant|org/i);
    }
  });
});
