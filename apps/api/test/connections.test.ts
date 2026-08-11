import { createServer, type Server } from 'node:http';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createApiKeyClient, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;
let stub: Server;
let stubUrl: string;
let stubStatus = 200;

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://postgres:dev_password_change_me@localhost:5432/xperiment';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
  auth = await createAuthedUser(app);
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
    `TRUNCATE connections, workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows, audit_events CASCADE`,
  );
});

async function createTelegramConnection(): Promise<string> {
  const r = await auth.inject({
    method: 'POST',
    url: '/v1/connections',
    payload: { connectorKey: 'telegram', name: 'Bot', payload: { botToken: 'SECRET-TOKEN', baseUrl: stubUrl } },
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ id: string }>().id;
}

describe('connections envelope encryption and audit', () => {
  async function auditRows(action: string): Promise<
    { action: string; target_id: string | null; actor_kind: string; actor_api_key_id: string | null; actor_user_id: string | null; outcome: string; metadata: Record<string, unknown> }[]
  > {
    const r = await pool.query<{
      action: string;
      target_id: string | null;
      actor_kind: string;
      actor_api_key_id: string | null;
      actor_user_id: string | null;
      outcome: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, target_id, actor_kind, actor_api_key_id, actor_user_id, outcome, metadata
         FROM audit_events WHERE action = $1 ORDER BY id`,
      [action],
    );
    return r.rows;
  }

  test('a created connection is stored at the envelope version', async () => {
    const id = await createTelegramConnection();
    const row = await pool.query<{ enc_version: number; encrypted_payload: Buffer }>(
      `SELECT enc_version, encrypted_payload FROM connections WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]!.enc_version).toBe(1);
    expect(row.rows[0]!.encrypted_payload.toString('utf8')).not.toContain('SECRET-TOKEN');
    // Marker byte of the v1 envelope layout.
    expect(row.rows[0]!.encrypted_payload[0]).toBe(1);
  });

  test('creating a connection writes exactly one credential.create audit row', async () => {
    const id = await createTelegramConnection();
    const rows = await auditRows('credential.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe(id);
    expect(rows[0]!.actor_kind).toBe('user');
    expect(rows[0]!.metadata).toMatchObject({ connectorKey: 'telegram' });
    // The secret must never reach the audit row.
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('SECRET-TOKEN');
  });

  test('a rejected create writes no audit row', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'telegram', name: 'Bad', payload: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(await auditRows('credential.create')).toHaveLength(0);
  });

  test('deleting a connection audits it, and a 404 delete does not', async () => {
    const id = await createTelegramConnection();
    expect((await auth.inject({ method: 'DELETE', url: `/v1/connections/${id}` })).statusCode).toBe(204);
    expect((await auth.inject({ method: 'DELETE', url: `/v1/connections/${id}` })).statusCode).toBe(404);
    const rows = await auditRows('credential.delete');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe(id);
  });

  test('testing a connection audits the read with its outcome', async () => {
    const id = await createTelegramConnection();
    const ok = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(ok.json<{ ok: boolean }>().ok).toBe(true);
    stubStatus = 500;
    const bad = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(bad.json<{ ok: boolean }>().ok).toBe(false);
    const rows = await auditRows('credential.test');
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'failure']);
    expect(JSON.stringify(rows)).not.toContain('SECRET-TOKEN');
  });

  test('rotating a connection audits it without echoing either secret', async () => {
    const id = await createTelegramConnection();
    const r = await auth.inject({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { payload: { botToken: 'ROTATED-TOKEN', baseUrl: stubUrl } },
    });
    expect(r.statusCode).toBe(200);
    const rows = await auditRows('credential.rotate');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe(id);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('SECRET-TOKEN');
    expect(dump).not.toContain('ROTATED-TOKEN');
  });

  test('an api-key caller is recorded as the api_key actor, not as a user', async () => {
    const key = await createApiKeyClient(app, auth, 'builder');
    const r = await key.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'telegram', name: 'ByKey', payload: { botToken: 'K-SECRET', baseUrl: stubUrl } },
    });
    expect(r.statusCode).toBe(201);
    const rows = await auditRows('credential.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_kind).toBe('api_key');
    expect(rows[0]!.actor_api_key_id).toBe(key.id);
    expect(rows[0]!.actor_user_id).toBeNull();
  });
});

describe('connections API', () => {
  test('create stores encrypted and never echoes the payload', async () => {
    const id = await createTelegramConnection();
    const raw = await pool.query(`SELECT encrypted_payload FROM connections WHERE id = $1`, [id]);
    expect((raw.rows[0] as { encrypted_payload: Buffer }).encrypted_payload.toString('utf8')).not.toContain(
      'SECRET-TOKEN',
    );
    const list = await auth.inject({ method: 'GET', url: '/v1/connections' });
    const items = list.json<{ items: Record<string, unknown>[] }>().items;
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('SECRET-TOKEN');
  });

  test('accepts the beta connector payloads (whatsapp, smtp, googleSheets)', async () => {
    const whatsapp = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'whatsapp', name: 'WA', payload: { accessToken: 'WA-SECRET', phoneNumberId: '555', baseUrl: stubUrl } },
    });
    expect(whatsapp.statusCode).toBe(201);
    const smtp = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'smtp', name: 'Mail', payload: { host: 'smtp.test', port: '587', user: 'u', password: 'SMTP-SECRET', from: 'a@b.co' } },
    });
    expect(smtp.statusCode).toBe(201); // port string coerces
    const sheets = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'googleSheets', name: 'Sheet', payload: { serviceAccountEmail: 'svc@x.iam.gserviceaccount.com', privateKey: 'SHEETS-SECRET' } },
    });
    expect(sheets.statusCode).toBe(201);
    // None of the secrets leak into the listing.
    const list = await auth.inject({ method: 'GET', url: '/v1/connections' });
    const body = JSON.stringify(list.json());
    for (const secret of ['WA-SECRET', 'SMTP-SECRET', 'SHEETS-SECRET']) expect(body).not.toContain(secret);
  });

  test('whatsapp test route routes to the connector and reports ok/fail', async () => {
    const created = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'whatsapp', name: 'WA', payload: { accessToken: 'WA-SECRET', phoneNumberId: '555', baseUrl: stubUrl } },
    });
    const id = created.json<{ id: string }>().id;
    const ok = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(ok.json()).toEqual({ ok: true });
    stubStatus = 403;
    const fail = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(fail.json<{ ok: boolean }>().ok).toBe(false);
  });

  test('rotation keeps the id, which is the entire point', async () => {
    // Without this route an expired provider token meant: create a second connection,
    // hand-edit connectionRef on every node, republish every workflow, then delete the
    // old one. Keeping the id is what makes published versions keep working.
    const id = await createTelegramConnection();
    const r = await auth.inject({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { payload: { botToken: 'ROTATED-TOKEN', baseUrl: stubUrl } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ id: string }>().id).toBe(id);
    const list = await auth.inject({ method: 'GET', url: '/v1/connections' });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  test('rotation replaces the stored payload rather than merging into it', async () => {
    // A merge would let someone submit only the token they came to rotate and keep a
    // stale phoneNumberId, and the mismatch would surface as a failed production run
    // rather than a failed save.
    const created = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        connectorKey: 'whatsapp',
        name: 'WA',
        payload: { accessToken: 'OLD-WA', phoneNumberId: '555', baseUrl: stubUrl },
      },
    });
    const id = created.json<{ id: string }>().id;
    const partial = await auth.inject({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { payload: { accessToken: 'NEW-WA' } },
    });
    expect(partial.statusCode).toBe(400);
    const full = await auth.inject({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { payload: { accessToken: 'NEW-WA', phoneNumberId: '555', baseUrl: stubUrl } },
    });
    expect(full.statusCode).toBe(200);
  });

  test('rotation cannot repoint a connection at another connector', async () => {
    // connectorKey comes from the stored row. Accepting it from the caller would leave
    // published nodes calling a connector whose payload no longer matches.
    const id = await createTelegramConnection();
    const r = await auth.inject({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { connectorKey: 'openai', payload: { apiKey: 'sk-x' } },
    });
    expect(r.statusCode).toBe(400);
  });

  test('a rotated credential is what the test route then dials with', async () => {
    const id = await createTelegramConnection();
    await auth.inject({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { name: 'Renamed bot', payload: { botToken: 'ROTATED-TOKEN', baseUrl: stubUrl } },
    });
    const ok = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(ok.json()).toEqual({ ok: true });
    const list = await auth.inject({ method: 'GET', url: '/v1/connections' });
    const items = list.json<{ items: { name: string }[] }>().items;
    expect(items[0]!.name).toBe('Renamed bot');
    expect(JSON.stringify(items)).not.toContain('ROTATED-TOKEN');
  });

  test('rotating an unknown connection is a 404, not a create', async () => {
    const r = await auth.inject({
      method: 'PUT',
      url: '/v1/connections/00000000-0000-0000-0000-000000000009',
      payload: { payload: { botToken: 'x' } },
    });
    expect(r.statusCode).toBe(404);
    const list = await auth.inject({ method: 'GET', url: '/v1/connections' });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  test('create rejects bad payloads and unknown connector keys', async () => {
    const bad = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'telegram', name: 'x', payload: { nope: true } },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'fax', name: 'x', payload: {} },
    });
    expect(unknown.statusCode).toBe(400);
  });

  test('test route reports ok and generic failure', async () => {
    const id = await createTelegramConnection();
    const ok = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(ok.json()).toEqual({ ok: true });
    stubStatus = 401;
    const fail = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    const body = fail.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('connection test failed');
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
  });

  test('delete works but conflicts when referenced by a published version', async () => {
    const id = await createTelegramConnection();
    const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'W' } });
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
    await auth.inject({
      method: 'PUT',
      url: `/v1/workflows/${wfId}/draft`,
      headers: { 'if-match': '1' },
      payload: { definition },
    });
    const pub = await auth.inject({ method: 'POST', url: `/v1/workflows/${wfId}/publish` });
    expect(pub.statusCode).toBe(201);
    const conflict = await auth.inject({ method: 'DELETE', url: `/v1/connections/${id}` });
    expect(conflict.statusCode).toBe(409);
    const other = await createTelegramConnection();
    const gone = await auth.inject({ method: 'DELETE', url: `/v1/connections/${other}` });
    expect(gone.statusCode).toBe(204);
  });

  test('publish blocks a credentialed node without connectionRef; passes once set', async () => {
    const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'W2' } });
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
    await auth.inject({
      method: 'PUT',
      url: `/v1/workflows/${wfId}/draft`,
      headers: { 'if-match': '1' },
      payload: { definition },
    });
    const blocked = await auth.inject({ method: 'POST', url: `/v1/workflows/${wfId}/publish` });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json<{ errors: { code: string }[] }>().errors.some((e) => e.code === 'connection_required')).toBe(
      true,
    );

    const connId = await createTelegramConnection();
    const withRef = structuredClone(definition) as { nodes: Record<string, unknown>[] };
    withRef.nodes[1]!['connectionRef'] = connId;
    await auth.inject({
      method: 'PUT',
      url: `/v1/workflows/${wfId}/draft`,
      headers: { 'if-match': '2' },
      payload: { definition: withRef },
    });
    const okPub = await auth.inject({ method: 'POST', url: `/v1/workflows/${wfId}/publish` });
    expect(okPub.statusCode).toBe(201);
  });

  test('postgres connection test against the real database', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/connections',
      payload: { connectorKey: 'postgres', name: 'DB', payload: { connectionString: DB_URL } },
    });
    const id = r.json<{ id: string }>().id;
    const ok = await auth.inject({ method: 'POST', url: `/v1/connections/${id}/test` });
    expect(ok.json()).toEqual({ ok: true });
  });
});
