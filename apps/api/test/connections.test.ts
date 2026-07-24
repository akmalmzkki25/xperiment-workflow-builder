import { createServer, type Server } from 'node:http';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
let stub: Server;
let stubUrl: string;
let stubStatus = 200;

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://xperiment:xperiment@localhost:5432/xperiment';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
  stub = createServer((_req, res) => {
    res.statusCode = stubStatus;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: stubStatus < 400 }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const addr = stub.address();
  stubUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  stubStatus = 200;
  await pool.query(
    `TRUNCATE connections, workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

async function createTelegramConnection(): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/connections',
    payload: { connectorKey: 'telegram', name: 'Bot', payload: { botToken: 'SECRET-TOKEN', baseUrl: stubUrl } },
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ id: string }>().id;
}

describe('connections API', () => {
  test('create stores encrypted and never echoes the payload', async () => {
    const id = await createTelegramConnection();
    const raw = await pool.query(`SELECT encrypted_payload FROM connections WHERE id = $1`, [id]);
    expect((raw.rows[0] as { encrypted_payload: Buffer }).encrypted_payload.toString('utf8')).not.toContain(
      'SECRET-TOKEN',
    );
    const list = await app.inject({ method: 'GET', url: '/v1/connections' });
    const items = list.json<{ items: Record<string, unknown>[] }>().items;
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('SECRET-TOKEN');
  });

  test('create rejects bad payloads and unknown connector keys', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'telegram', name: 'x', payload: { nope: true } },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'fax', name: 'x', payload: {} },
    });
    expect(unknown.statusCode).toBe(400);
  });

  test('test route reports ok and generic failure', async () => {
    const id = await createTelegramConnection();
    const ok = await app.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(ok.json()).toEqual({ ok: true });
    stubStatus = 401;
    const fail = await app.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    const body = fail.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('connection test failed');
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
  });

  test('delete works but conflicts when referenced by a published version', async () => {
    const id = await createTelegramConnection();
    const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'W' } });
    const wfId = created.json<{ id: string }>().id;
    const definition = {
      schemaVersion: '0.1',
      workflow: { id: 'w', name: 'w' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        {
          id: 'send',
          kind: 'action',
          type: 'telegram.sendMessage',
          operationVersion: '0.1.0',
          parameters: { chatId: '1', text: 'hi' },
          connectionRef: id,
        },
      ],
      edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'send', port: 'input' } }],
    };
    await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${wfId}/draft`,
      headers: { 'if-match': '1' },
      payload: { definition },
    });
    const pub = await app.inject({ method: 'POST', url: `/v1/workflows/${wfId}/publish` });
    expect(pub.statusCode).toBe(201);
    const conflict = await app.inject({ method: 'DELETE', url: `/v1/connections/${id}` });
    expect(conflict.statusCode).toBe(409);
    const other = await createTelegramConnection();
    const gone = await app.inject({ method: 'DELETE', url: `/v1/connections/${other}` });
    expect(gone.statusCode).toBe(204);
  });

  test('publish blocks a credentialed node without connectionRef; passes once set', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'W2' } });
    const wfId = created.json<{ id: string }>().id;
    const definition = {
      schemaVersion: '0.1',
      workflow: { id: 'w2', name: 'w2' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        {
          id: 'send',
          kind: 'action',
          type: 'telegram.sendMessage',
          operationVersion: '0.1.0',
          parameters: { chatId: '1', text: 'hi' },
        },
      ],
      edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'send', port: 'input' } }],
    };
    await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${wfId}/draft`,
      headers: { 'if-match': '1' },
      payload: { definition },
    });
    const blocked = await app.inject({ method: 'POST', url: `/v1/workflows/${wfId}/publish` });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json<{ errors: { code: string }[] }>().errors.some((e) => e.code === 'connection_required')).toBe(
      true,
    );

    const connId = await createTelegramConnection();
    const withRef = structuredClone(definition) as { nodes: Record<string, unknown>[] };
    withRef.nodes[1]!['connectionRef'] = connId;
    await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${wfId}/draft`,
      headers: { 'if-match': '2' },
      payload: { definition: withRef },
    });
    const okPub = await app.inject({ method: 'POST', url: `/v1/workflows/${wfId}/publish` });
    expect(okPub.statusCode).toBe(201);
  });

  test('postgres connection test against the real database', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'postgres', name: 'DB', payload: { connectionString: DB_URL } },
    });
    const id = r.json<{ id: string }>().id;
    const ok = await app.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(ok.json()).toEqual({ ok: true });
  });
});
