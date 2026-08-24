import { createServer, type Server } from 'node:http';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

const FAKE_KEY = 'sk-or-fake-key-abc123';

let pool: Pool;
let stub: Server;
let stubUrl: string;
let lastAuthHeader: string | undefined;

/**
 * One scripted reply per model call, chosen by how many tool results the model has
 * already been given. Stateless on purpose: a server-side counter leaks between tests in
 * a serial suite and produces the worst kind of flake.
 */
type Script = (toolResults: number, userText: string) => string | { status: number };
let script: Script = () => text('ok');

const USAGE = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

/**
 * OpenAI-style streaming chunks. The agent asks the provider for a stream, so a stub that
 * answers with one plain JSON body produces no text at all — and the streaming UI would
 * be theatre tested against a lump.
 */
function sse(chunks: Record<string, unknown>[]): string {
  const body = chunks.map((c) => ['data: ', JSON.stringify(c), '\n\n'].join('')).join('');
  return `${body}data: [DONE]\n\n`;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return {
    id: 'x',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub',
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: USAGE,
  };
}

function text(content: string): string {
  // Split so the test can prove deltas arrive incrementally rather than in one piece.
  const half = Math.ceil(content.length / 2);
  return sse([
    chunk({ role: 'assistant', content: content.slice(0, half) }),
    chunk({ content: content.slice(half) }),
    chunk({}, 'stop'),
  ]);
}

function callTool(name: string, args: unknown): string {
  return sse([
    chunk({
      role: 'assistant',
      tool_calls: [
        { index: 0, id: `c${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    }),
    chunk({}, 'tool_calls'),
  ]);
}

function buildAgentServer(apiKey: string | null): FastifyInstance {
  return buildServer({
    pool,
    registry: createDefaultRegistry({ allowPrivateIps: true }),
    ai: { apiKey, model: 'stub/stub-model', baseUrl: stubUrl },
  });
}

/** Reads the whole SSE body and returns the decoded frames in order. */
function framesOf(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((b) => JSON.parse(b.slice(b.indexOf('data:') + 5).trim()) as Record<string, unknown>);
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  stub = createServer((req, res) => {
    lastAuthHeader = req.headers['authorization'];
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { messages?: { role: string; content?: unknown }[] };
      const messages = body.messages ?? [];
      const toolResults = messages.filter((m) => m.role === 'tool').length;
      const firstUser = messages.find((m) => m.role === 'user');
      const userText = typeof firstUser?.content === 'string' ? firstUser.content : JSON.stringify(firstUser?.content ?? '');
      const out = script(toolResults, userText);
      if (typeof out !== 'string') {
        res.statusCode = out.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: `upstream failure for ${lastAuthHeader}` } }));
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      res.end(out);
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const addr = stub.address();
  stubUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await pool.end();
});
beforeEach(() => {
  script = () => text('ok');
  lastAuthHeader = undefined;
});

async function newConversation(auth: AuthedUser): Promise<string> {
  const r = await auth.inject({ method: 'POST', url: '/v1/agent/conversations', payload: {} });
  expect(r.statusCode).toBe(201);
  return r.json<{ conversationId: string }>().conversationId;
}

describe('POST /v1/agent/conversations/:id/messages', () => {
  test('streams a turn: text frames, then done', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    script = () => text('Halo, saya buatkan.');
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'buatkan pengingat' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const frames = framesOf(r.body);
    expect(frames[0]).toMatchObject({ type: 'turn', conversationId: id });
    expect(frames.filter((f) => f.type === 'text').map((f) => f['delta']).join('')).toContain('Halo');
    expect(frames.at(-1)).toMatchObject({ type: 'done', stopReason: 'complete' });
    expect(lastAuthHeader).toBe(`Bearer ${FAKE_KEY}`);
    await app.close();
  });

  test('the transcript keeps both turns, so a reload does not lose the conversation', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    script = () => text('sudah saya catat');
    await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'ingatkan makan siang' },
    });
    const r = await auth.inject({ method: 'GET', url: `/v1/agent/conversations/${id}` });
    const messages = r.json<{ messages: { role: string; content: string }[] }>().messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe('ingatkan makan siang');
    await app.close();
  });

  test('a tool call is reported as start then end, and the draft lands', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    script = (n) => (n === 0 ? callTool('create_workflow', { name: 'Pengingat makan' }) : text('sudah dibuat'));
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'buatkan' },
    });
    const frames = framesOf(r.body);
    const start = frames.find((f) => f.type === 'tool.start');
    const end = frames.find((f) => f.type === 'tool.end');
    expect(start).toMatchObject({ tool: 'create_workflow' });
    expect(end).toMatchObject({ tool: 'create_workflow', ok: true });
    // Human phrasing, not a function name: the chips are the progress indicator.
    expect(start!['title']).toBe('Creating the workflow');

    const wf = await auth.inject({ method: 'GET', url: '/v1/workflows' });
    expect(wf.json<{ items: { name: string }[] }>().items.map((i) => i.name)).toContain('Pengingat makan');
    await app.close();
  });

  test('a credential the agent cannot have becomes a connection.required frame', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    script = (n) =>
      n === 0
        ? callTool('request_credential', { connectorKey: 'telegram', reason: 'to send the reminder', nodeId: 'notify' })
        : text('silakan hubungkan dulu');
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'kirim lewat telegram' },
    });
    const frames = framesOf(r.body);
    const req = frames.find((f) => f.type === 'connection.required');
    expect(req).toMatchObject({ connectorKey: 'telegram', displayName: 'Telegram' });
    expect(String(req!['formUrl'])).toContain('connector=telegram');
    expect(frames.at(-1)).toMatchObject({ stopReason: 'awaiting_connection' });
    await app.close();
  });

  test('a credential pasted into the chat is refused, and never stored', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    const token = '123456789:AAHk9bQ2wLmNpXrTvYzB3cDeFgHiJkLmNoP';
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: `pakai token ini ${token}` },
    });
    const frames = framesOf(r.body);
    expect(frames.at(-1)).toMatchObject({ stopReason: 'refused' });
    expect(r.body).not.toContain(token);
    // Not merely scrubbed on the way out — never written at all.
    const rows = await pool.query(`SELECT content FROM agent_messages WHERE conversation_id = $1`, [id]);
    expect(JSON.stringify(rows.rows)).not.toContain('AAHk9');
    await app.close();
  });

  test('a provider failure becomes an error frame and never echoes the key', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    script = () => ({ status: 500 });
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'buatkan' },
    });
    expect(r.statusCode).toBe(200); // the stream had already committed 200
    const frames = framesOf(r.body);
    expect(frames.find((f) => f.type === 'error')).toMatchObject({ code: 'provider_error', retriable: true });
    // And it must not be reported as a completed turn — silence read as success is how
    // somebody concludes the product is broken rather than the provider.
    expect(frames.at(-1)).toMatchObject({ stopReason: 'error' });
    expect(r.body).not.toContain(FAKE_KEY);
    await app.close();
  });

  test('a failed turn still bills the tokens the provider answered with', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    // One good call, then the provider dies. 110 tokens were spent either way.
    script = (n) => (n === 0 ? callTool('list_connections', {}) : { status: 500 });
    await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'buatkan' },
    });
    const rows = await pool.query(
      `SELECT quantity FROM usage_events WHERE workspace_id=$1 AND metric='ai_tokens'`,
      [auth.workspaceId],
    );
    expect(rows.rowCount).toBe(1);
    expect(Number((rows.rows[0] as { quantity: string }).quantity)).toBeGreaterThan(0);
    await app.close();
  });

  test('everything that can refuse does so before the stream commits', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    // Once 200 text/event-stream is on the wire, a problem document is impossible.
    const bad = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: '' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('problem+json');

    const missing = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/00000000-0000-0000-0000-000000000000/messages`,
      payload: { message: 'hi' },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  test('503 when no key is configured', async () => {
    const app = buildAgentServer(null);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'hi' },
    });
    expect(r.statusCode).toBe(503);
    await app.close();
  });

  test('an operator cannot start a turn', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    const operator = await addMemberWithRole(app, pool, auth.workspaceId, 'operator');
    const r = await operator.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${id}/messages`,
      payload: { message: 'hi' },
    });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  test('another workspace cannot read the transcript', async () => {
    const app = buildAgentServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const id = await newConversation(auth);
    const stranger = await createAuthedUser(app);
    const r = await stranger.inject({ method: 'GET', url: `/v1/agent/conversations/${id}` });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
