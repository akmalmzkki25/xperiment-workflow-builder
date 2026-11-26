import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE workflow_versions, workflow_drafts, workflows, connections CASCADE`);
});

/** A definition whose only interesting property is that one node needs a credential. */
function notifyIr(connectionRef?: string) {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_source', name: 'Pesanan baru' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'notify',
        kind: 'action',
        type: 'telegram.sendMessage',
        operationVersion: '0.1.0',
        parameters: { chatId: '123', text: 'halo' },
        ...(connectionRef ? { connectionRef } : {}),
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'notify', port: 'input' } }],
    metadata: { layout: { t: { x: 40, y: 80 } } },
  };
}

async function makeConnection(who: AuthedUser): Promise<string> {
  const r = await who.inject({
    method: 'POST',
    url: '/v1/connections',
    payload: { connectorKey: 'telegram', name: 'Bot', payload: { botToken: 'FAKE-TOKEN' } },
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ id: string }>().id;
}

async function makeWorkflow(who: AuthedUser, definition: unknown): Promise<string> {
  const created = await who.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Pesanan baru' } });
  const id = created.json<{ id: string }>().id;
  const put = await who.inject({
    method: 'PUT',
    url: `/v1/workflows/${id}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition },
  });
  expect(put.statusCode).toBe(200);
  return id;
}

interface ExportDoc {
  xperimentExport: number;
  name: string;
  definition: { workflow: { id: string; name: string }; nodes: { id: string; connectionRef?: string }[] };
  requiredConnections: { nodeId: string; connectorKey: string; wasConnected: boolean }[];
}

describe('GET /v1/workflows/:id/export', () => {
  test('exports the draft with its layout and a connector manifest in words', async () => {
    const connId = await makeConnection(auth);
    const wfId = await makeWorkflow(auth, notifyIr(connId));
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` });
    expect(r.statusCode).toBe(200);
    const doc = r.json<ExportDoc>();
    expect(doc.xperimentExport).toBe(1);
    expect(doc.name).toBe('Pesanan baru');
    expect(doc.requiredConnections).toEqual([{ nodeId: 'notify', connectorKey: 'telegram', wasConnected: true }]);
    expect((doc.definition as unknown as { metadata: unknown }).metadata).toEqual({ layout: { t: { x: 40, y: 80 } } });
  });

  test('names the file after the workflow so a folder of exports is readable', async () => {
    const wfId = await makeWorkflow(auth, notifyIr());
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` });
    expect(r.headers['content-disposition']).toContain('.xperiment.json');
  });

  test('a name carrying a newline and a quote cannot splice the header', async () => {
    // A workflow name is free text and reaches Content-Disposition. Unsanitised, this
    // name is either a header-injection or an ERR_INVALID_CHAR 500 — never a download.
    const created = await auth.inject({
      method: 'POST',
      url: '/v1/workflows',
      payload: { name: 'evil"\r\nX-Injected: yes' },
    });
    const id = created.json<{ id: string }>().id;
    await auth.inject({
      method: 'PUT',
      url: `/v1/workflows/${id}/draft`,
      headers: { 'if-match': '1' },
      payload: { definition: notifyIr() },
    });
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/export` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-injected']).toBeUndefined();
    // The whole name survives as one slug — what matters is that the CR, the LF and the
    // quote did not, so there is exactly one header here.
    expect(r.headers['content-disposition']).toBe('attachment; filename="evil-x-injected-yes.xperiment.json"');
  });

  test('?version= exports a published version, so a mid-edit draft is not the only way out', async () => {
    const wfId = await makeWorkflow(auth, notifyIr(await makeConnection(auth)));
    const published = await auth.inject({ method: 'POST', url: `/v1/workflows/${wfId}/publish` });
    expect(published.statusCode).toBe(201);
    const versionId = published.json<{ id: string }>().id;
    // Now leave the draft in a state that cannot be exported at all.
    await auth.inject({
      method: 'PUT',
      url: `/v1/workflows/${wfId}/draft`,
      headers: { 'if-match': '2' },
      payload: { definition: { nodes: 'broken' } },
    });
    expect((await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` })).statusCode).toBe(422);
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export?version=${versionId}` });
    expect(r.statusCode).toBe(200);
    expect(r.json<ExportDoc>().definition.nodes).toHaveLength(2);
  });

  test('a version belonging to another workflow is not exportable through this one', async () => {
    const connId = await makeConnection(auth);
    const mine = await makeWorkflow(auth, notifyIr(connId));
    const theirs = await makeWorkflow(auth, notifyIr(connId));
    const published = await auth.inject({ method: 'POST', url: `/v1/workflows/${theirs}/publish` });
    const versionId = published.json<{ id: string }>().id;
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${mine}/export?version=${versionId}` });
    expect(r.statusCode).toBe(404);
  });

  test('a half-built draft is a clean 422, not a 500', async () => {
    const wfId = await makeWorkflow(auth, { schemaVersion: '0.1', nodes: 'not-a-list' });
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` });
    expect(r.statusCode).toBe(422);
  });

  test('another workspace cannot export a workflow it cannot see', async () => {
    const wfId = await makeWorkflow(auth, notifyIr());
    const stranger = await createAuthedUser(app);
    const r = await stranger.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` });
    expect(r.statusCode).toBe(404);
  });

  test('a billing member, who cannot read workflows, cannot export one either', async () => {
    const wfId = await makeWorkflow(auth, notifyIr());
    const billing = await addMemberWithRole(app, pool, auth.workspaceId, 'billing');
    const r = await billing.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` });
    expect(r.statusCode).toBe(403);
  });
});

describe('POST /v1/workflows/import', () => {
  test('an import into the same workspace is a fully wired duplicate', async () => {
    const connId = await makeConnection(auth);
    const wfId = await makeWorkflow(auth, notifyIr(connId));
    const doc = (await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` })).json<ExportDoc>();

    const r = await auth.inject({ method: 'POST', url: '/v1/workflows/import', payload: doc });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ id: string; name: string; reconnect: unknown[] }>();
    expect(body.reconnect).toEqual([]);
    expect(body.id).not.toBe(wfId);

    const detail = await auth.inject({ method: 'GET', url: `/v1/workflows/${body.id}` });
    const draft = detail.json<{ draft: { definition: ExportDoc['definition'] } }>().draft;
    expect(draft.definition.nodes[1]?.connectionRef).toBe(connId);
    // Not the source workflow's id: the row it now belongs to.
    expect(draft.definition.workflow).toEqual({ id: body.id, name: 'Pesanan baru' });
  });

  test('a cross-workspace import strips the foreign credential and names what to reconnect', async () => {
    const connId = await makeConnection(auth);
    const wfId = await makeWorkflow(auth, notifyIr(connId));
    const doc = (await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` })).json<ExportDoc>();

    const other = await createAuthedUser(app);
    const r = await other.inject({ method: 'POST', url: '/v1/workflows/import', payload: doc });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ id: string; reconnect: { nodeId: string; connectorKey: string }[] }>();
    expect(body.reconnect).toEqual([{ nodeId: 'notify', connectorKey: 'telegram', wasConnected: true }]);

    const detail = await other.inject({ method: 'GET', url: `/v1/workflows/${body.id}` });
    const draft = detail.json<{ draft: { definition: ExportDoc['definition'] } }>().draft;
    expect(draft.definition.nodes[1]?.connectionRef).toBeUndefined();
  });

  test('the reconnect list agrees with what publish then refuses', async () => {
    // The whole point of stripping rather than leaving a dangling UUID: the two answers
    // must name the same node. A surviving foreign id would say connection_not_found on
    // a node the import never mentioned.
    const connId = await makeConnection(auth);
    const wfId = await makeWorkflow(auth, notifyIr(connId));
    const doc = (await auth.inject({ method: 'GET', url: `/v1/workflows/${wfId}/export` })).json<ExportDoc>();
    const other = await createAuthedUser(app);
    const imported = await other.inject({ method: 'POST', url: '/v1/workflows/import', payload: doc });
    const newId = imported.json<{ id: string }>().id;

    const v = await other.inject({ method: 'POST', url: `/v1/workflows/${newId}/validate` });
    const findings = v.json<{ findings: { code: string; nodeId?: string }[] }>().findings;
    expect(findings.map((f) => f.code)).toContain('connection_required');
    expect(findings.find((f) => f.code === 'connection_required')?.nodeId).toBe('notify');
  });

  test('an unknown format version is refused rather than guessed at', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/workflows/import',
      payload: { xperimentExport: 99, name: 'X', definition: notifyIr() },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('unsupported_format');
  });

  test('a definition that is not a workflow is refused before anything is created', async () => {
    const before = await auth.inject({ method: 'GET', url: '/v1/workflows' });
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/workflows/import',
      payload: { xperimentExport: 1, name: 'X', definition: { nodes: 'nope' } },
    });
    expect(r.statusCode).toBe(422);
    const after = await auth.inject({ method: 'GET', url: '/v1/workflows' });
    expect(after.json<{ items: unknown[] }>().items).toHaveLength(before.json<{ items: unknown[] }>().items.length);
  });

  test('a file without the format key is refused rather than imported blind', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/workflows/import',
      payload: { name: 'X', definition: notifyIr() },
    });
    expect(r.statusCode).toBe(400);
  });

  test('the name in the request wins over the name in the file', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/workflows/import',
      payload: { xperimentExport: 1, name: 'From file', definition: notifyIr(), overrideName: 'Milik saya' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json<{ name: string }>().name).toBe('Milik saya');
  });

  test('import creates a draft, never a published version', async () => {
    // Importing a file must not put a workflow live. Publishing stays a decision.
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/workflows/import',
      payload: { xperimentExport: 1, name: 'X', definition: notifyIr() },
    });
    const id = r.json<{ id: string }>().id;
    const detail = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}` });
    const body = detail.json<{ versions: unknown[]; activeVersionId: string | null; draft: unknown }>();
    expect(body.versions).toHaveLength(0);
    expect(body.activeVersionId).toBeNull();
    expect(body.draft).toBeTruthy();
  });

  test('an operator, who may run workflows but not write them, cannot import', async () => {
    const operator = await addMemberWithRole(app, pool, auth.workspaceId, 'operator');
    const r = await operator.inject({
      method: 'POST',
      url: '/v1/workflows/import',
      payload: { xperimentExport: 1, name: 'X', definition: notifyIr() },
    });
    expect(r.statusCode).toBe(403);
  });
});
