import { createServer, type Server } from 'node:http';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

const FAKE_KEY = 'sk-or-fake-key-abc123';

let pool: Pool;
let stub: Server;
let stubUrl: string;
/** Queue of assistant `content` strings the stub returns, in order. */
let scripted: string[] = [];
let stubStatus = 200;
let lastAuthHeader: string | undefined;

const validIr = () => ({
  schemaVersion: '0.1',
  workflow: { id: 'wf_ai', name: 'AI flow' },
  entrypoints: ['hook'],
  nodes: [
    { id: 'hook', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'none' } },
    { id: 'shape', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: true } } },
  ],
  edges: [{ id: 'e_hook_main_shape', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'shape', port: 'input' } }],
});

function buildAiServer(apiKey: string | null): FastifyInstance {
  return buildServer({
    pool,
    registry: createDefaultRegistry(),
    ai: { apiKey, model: 'google/gemini-3.1-flash-lite', baseUrl: stubUrl },
  });
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  stub = createServer((req, res) => {
    lastAuthHeader = req.headers['authorization'];
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.statusCode = stubStatus;
      res.setHeader('content-type', 'application/json');
      if (stubStatus >= 400) {
        // Provider error bodies can echo the request Authorization header.
        res.end(JSON.stringify({ error: { message: `upstream failure for ${lastAuthHeader}` } }));
        return;
      }
      const content = scripted.shift() ?? '{}';
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
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
  scripted = [];
  stubStatus = 200;
  lastAuthHeader = undefined;
});

describe('POST /v1/ai/generate', () => {
  test('returns a validated draft IR from a valid completion', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth: AuthedUser = await createAuthedUser(app);
    scripted = [JSON.stringify(validIr())];
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: 'build a webhook to transform' } });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ ir: { nodes: unknown[] }; attempts: number }>();
    expect(body.ir.nodes).toHaveLength(2);
    expect(body.attempts).toBe(1);
    expect(lastAuthHeader).toBe(`Bearer ${FAKE_KEY}`);
    await app.close();
  });

  test('repairs an invalid-then-valid sequence', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const broken = JSON.stringify({ schemaVersion: '0.1', workflow: { id: 'w', name: 'n' }, entrypoints: ['ghost'], nodes: [], edges: [] });
    scripted = [broken, JSON.stringify(validIr())];
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: 'build it' } });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ attempts: number }>().attempts).toBe(2);
    await app.close();
  });

  test('returns 422 with findings when the model cannot comply', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    scripted = ['nonsense', 'still nonsense', 'nope'];
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: 'build it' } });
    expect(r.statusCode).toBe(422);
    expect(Array.isArray(r.json<{ findings: unknown[] }>().findings)).toBe(true);
    await app.close();
  });

  test('returns 503 when no key is configured', async () => {
    const app = buildAiServer(null);
    const auth = await createAuthedUser(app);
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: 'x' } });
    expect(r.statusCode).toBe(503);
    await app.close();
  });

  test('rejects an empty prompt', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: '' } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  test('never echoes the API key in any response body', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    scripted = ['nope', 'nope', 'nope'];
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: 'x' } });
    expect(r.body).not.toContain(FAKE_KEY);
    await app.close();
  });

  test('maps a provider failure to 502 without leaking the key', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    stubStatus = 500; // provider error whose body embeds the Authorization header
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/generate', payload: { prompt: 'x' } });
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain(FAKE_KEY);
    await app.close();
  });
});

describe('POST /v1/ai/edit', () => {
  test('revises a supplied definition', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    scripted = [JSON.stringify(validIr())];
    const current = { schemaVersion: '0.1', workflow: { id: 'wf_ai', name: 'old' }, entrypoints: ['hook'], nodes: [], edges: [] };
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/edit', payload: { prompt: 'add a transform', definition: current } });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ ir: { nodes: unknown[] } }>().ir.nodes).toHaveLength(2);
    await app.close();
  });

  test('repairs an invalid edit before succeeding', async () => {
    const app = buildAiServer(FAKE_KEY);
    const auth = await createAuthedUser(app);
    const broken = JSON.stringify({ schemaVersion: '0.1', workflow: { id: 'w', name: 'n' }, entrypoints: ['ghost'], nodes: [], edges: [] });
    scripted = [broken, JSON.stringify(validIr())];
    const current = { schemaVersion: '0.1', workflow: { id: 'wf_ai', name: 'old' }, entrypoints: [], nodes: [], edges: [] };
    const r = await auth.inject({ method: 'POST', url: '/v1/ai/edit', payload: { prompt: 'fix it', definition: current } });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ attempts: number }>().attempts).toBe(2);
    await app.close();
  });
});
