import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  appendAgentMessage,
  createAgentConversation,
  createCredentialRequest,
  createUser,
  createWorkspaceWithOwner,
  fulfilCredentialRequest,
  getAgentConversation,
  listAgentMessages,
  listOpenCredentialRequests,
  pruneExpired,
  looksLikeCredential,
  createPool,
  runMigrations,
  setConversationWorkflow,
} from '../src/index.js';

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newWorkspace(): Promise<{ workspaceId: string; userId: string }> {
  const user = await createUser(pool, { email: `ag-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Agent', userId: user!.id, actor: { actorKind: 'system' } });
  return { workspaceId: ws.id, userId: user!.id };
}

async function newConversation(): Promise<{ id: string; workspaceId: string }> {
  const { workspaceId, userId } = await newWorkspace();
  const c = await createAgentConversation(pool, { workspaceId, createdBy: userId, title: 'Pengingat makan' });
  return { id: c.id, workspaceId };
}

describe('looksLikeCredential', () => {
  test('catches the shapes Xperiment actually accepts', () => {
    // redactSecrets matches key NAMES, so it cannot see a token pasted as free text.
    // These are the formats a person could realistically paste into a chat box.
    expect(looksLikeCredential('123456789:AAHk9bQ2wLmNpXrTvYzB3cDeFgHiJkLmNoP')).toBe(true);
    expect(looksLikeCredential('my token is xoxb-1234-5678-abcdefghijklmnop')).toBe(true);
    expect(looksLikeCredential('sk-proj-abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
  });

  test('leaves ordinary sentences alone', () => {
    // A false positive here refuses somebody's legitimate message, so the cost of being
    // greedy is a product that appears broken.
    expect(looksLikeCredential('Remind me to eat lunch at 12:00 every day')).toBe(false);
    expect(looksLikeCredential('the chat id is -1001234567890')).toBe(false);
    expect(looksLikeCredential('use postgres on port 5432:5432 in compose')).toBe(false);
    expect(looksLikeCredential('')).toBe(false);
  });
});

describe('agent conversations', () => {
  test('a conversation belongs to a workspace and another one cannot read it', async () => {
    const { id, workspaceId } = await newConversation();
    expect(await getAgentConversation(pool, id, workspaceId)).toMatchObject({ title: 'Pengingat makan' });
    const stranger = await newWorkspace();
    expect(await getAgentConversation(pool, id, stranger.workspaceId)).toBeNull();
  });

  test('messages are ordered by id, not by created_at', async () => {
    // created_at defaults to transaction start, so a slow turn can commit a row that
    // sorts before one already visible.
    const { id, workspaceId } = await newConversation();
    const first = await appendAgentMessage(pool, { conversationId: id, workspaceId, role: 'user', content: 'one' });
    const second = await appendAgentMessage(pool, { conversationId: id, workspaceId, role: 'assistant', content: 'two' });
    await pool.query(`UPDATE agent_messages SET created_at = now() - interval '1 hour' WHERE id = $1`, [second.id]);
    const rows = await listAgentMessages(pool, id, workspaceId);
    expect(rows.map((r) => r.content)).toEqual(['one', 'two']);
    expect(Number(rows[0]!.id)).toBeLessThan(Number(rows[1]!.id));
    expect(first.id).not.toBe(second.id);
  });

  test('appendAgentMessage redacts tool arguments without the caller asking', async () => {
    // The guarantee has to live here, not in a docblock asking every call site nicely.
    const { id, workspaceId } = await newConversation();
    await appendAgentMessage(pool, {
      conversationId: id,
      workspaceId,
      role: 'assistant',
      content: 'wiring it up',
      toolCalls: [{ tool: 'set_node_connection', args: { botToken: 'SUPER-SECRET-VALUE', nodeId: 'notify' }, ok: true, ms: 4 }],
    });
    const raw = await pool.query(`SELECT tool_calls::text AS t FROM agent_messages WHERE conversation_id = $1`, [id]);
    const text = (raw.rows[0] as { t: string }).t;
    expect(text).not.toContain('SUPER-SECRET-VALUE');
    expect(text).toContain('notify');
  });

  test('a failed turn stays in the transcript with its outcome and its tokens', async () => {
    const { id, workspaceId } = await newConversation();
    await appendAgentMessage(pool, {
      conversationId: id,
      workspaceId,
      role: 'assistant',
      content: '',
      outcome: 'provider_error',
      inputTokens: 100,
      outputTokens: 10,
    });
    const rows = await listAgentMessages(pool, id, workspaceId);
    expect(rows[0]).toMatchObject({ outcome: 'provider_error', inputTokens: 100, outputTokens: 10 });
  });

  test('a message list never crosses into another workspace', async () => {
    const { id, workspaceId } = await newConversation();
    await appendAgentMessage(pool, { conversationId: id, workspaceId, role: 'user', content: 'mine' });
    const stranger = await newWorkspace();
    expect(await listAgentMessages(pool, id, stranger.workspaceId)).toEqual([]);
  });

  test('the conversation remembers which workflow it is building', async () => {
    const { id, workspaceId } = await newConversation();
    const wf = await pool.query(
      `INSERT INTO workflows (workspace_id, name) VALUES ($1, 'built by agent') RETURNING id`,
      [workspaceId],
    );
    const wfId = (wf.rows[0] as { id: string }).id;
    await setConversationWorkflow(pool, id, workspaceId, wfId);
    expect(await getAgentConversation(pool, id, workspaceId)).toMatchObject({ workflowId: wfId });
  });

  test('deleting the workflow leaves the conversation, without its link', async () => {
    // How something came to be specified outlives the thing itself.
    const { id, workspaceId } = await newConversation();
    const wf = await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1, 'doomed') RETURNING id`, [
      workspaceId,
    ]);
    const wfId = (wf.rows[0] as { id: string }).id;
    await setConversationWorkflow(pool, id, workspaceId, wfId);
    await pool.query(`DELETE FROM workflows WHERE id = $1`, [wfId]);
    expect(await getAgentConversation(pool, id, workspaceId)).toMatchObject({ workflowId: null });
  });

  test('deleting the workspace takes the whole conversation with it', async () => {
    const { workspaceId, userId } = await newWorkspace();
    const c = await createAgentConversation(pool, { workspaceId, createdBy: userId });
    await appendAgentMessage(pool, { conversationId: c.id, workspaceId, role: 'user', content: 'hi' });
    await createCredentialRequest(pool, { conversationId: c.id, workspaceId, connectorKey: 'telegram', reason: 'need it' });
    // Dependents that do not cascade from workspaces must go first; alert_rules is seeded
    // for every workspace and is ON DELETE NO ACTION.
    await pool.query(`DELETE FROM alert_events WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM alert_rules WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    for (const t of ['agent_conversations', 'agent_messages', 'agent_credential_requests']) {
      const left = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE workspace_id = $1`, [workspaceId]);
      expect((left.rows[0] as { n: number }).n, t).toBe(0);
    }
  });
});

describe('retention', () => {
  test('an old conversation is pruned and takes its messages with it', async () => {
    const { id, workspaceId } = await newConversation();
    await appendAgentMessage(pool, { conversationId: id, workspaceId, role: 'user', content: 'ancient' });
    await pool.query(`UPDATE agent_conversations SET updated_at = now() - interval '400 days' WHERE id = $1`, [id]);
    await pruneExpired(pool, { conversationDays: 90 });
    expect(await getAgentConversation(pool, id, workspaceId)).toBeNull();
    const left = await pool.query(`SELECT count(*)::int AS n FROM agent_messages WHERE conversation_id = $1`, [id]);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  test('a long conversation somebody is still using is not swept mid-sentence', async () => {
    // Dated by updated_at, not created_at, precisely for this row.
    const { id, workspaceId } = await newConversation();
    await pool.query(`UPDATE agent_conversations SET created_at = now() - interval '400 days' WHERE id = $1`, [id]);
    await appendAgentMessage(pool, { conversationId: id, workspaceId, role: 'user', content: 'still here' });
    await pruneExpired(pool, { conversationDays: 90 });
    expect(await getAgentConversation(pool, id, workspaceId)).not.toBeNull();
  });
});

describe('credential requests', () => {
  test('an open request is listed until it is fulfilled', async () => {
    const { id, workspaceId } = await newConversation();
    const req = await createCredentialRequest(pool, {
      conversationId: id,
      workspaceId,
      connectorKey: 'telegram',
      nodeId: 'notify',
      reason: 'to send the reminder',
    });
    expect((await listOpenCredentialRequests(pool, id, workspaceId)).map((r) => r.id)).toEqual([req.id]);

    const conn = await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'telegram','Bot','\\x00'::bytea,1) RETURNING id`,
      [workspaceId],
    );
    await fulfilCredentialRequest(pool, req.id, workspaceId, (conn.rows[0] as { id: string }).id);
    expect(await listOpenCredentialRequests(pool, id, workspaceId)).toEqual([]);
  });

  test('the table has no column that could hold a secret', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_credential_requests'`,
    );
    const names = (cols.rows as { column_name: string }[]).map((c) => c.column_name);
    // `connector_key` holds the string 'telegram'. What must not exist is a column that
    // could hold a credential VALUE.
    for (const n of names) expect(n, n).not.toMatch(/token|secret|password|payload|(?:api|private|server|bot)_key/i);
    expect(names).toContain('connector_key');
  });
});
