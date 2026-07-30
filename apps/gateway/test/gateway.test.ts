import { createHmac, randomBytes } from 'node:crypto';
import {
  createPool,
  createVersion,
  createWorkflow,
  DEFAULT_WORKSPACE_ID,
  deriveLegacyKey,
  encryptSecret,
  getExecutionDetail,
  latestNodeStates,
  openWait,
  runMigrations,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildGateway } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
const key = deriveLegacyKey('xperiment-dev-trigger-secret-change-me');

const hookIr = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_hook', name: 'Hook' },
  entrypoints: ['hook'],
  nodes: [
    {
      id: 'hook',
      kind: 'trigger',
      type: 'webhook.trigger',
      operationVersion: '0.1.0',
      parameters: { authMode: 'hmac' },
    },
    {
      id: 'echo',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: { ok: true } },
    },
  ],
  edges: [{ id: 'e1', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
};

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildGateway({ pool, triggerKey: key });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

async function seedHook(authMode: 'none' | 'token' | 'hmac', opts: { active?: boolean; idemPath?: string } = {}) {
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Hook' });
  await createVersion(pool, { workflowId: wf.id, definition: hookIr, hash: 'h' });
  const secret = randomBytes(12).toString('hex');
  const row = await upsertTrigger(pool, {
    workflowId: wf.id,
    nodeId: 'hook',
    type: 'webhook',
    authMode,
    ...(opts.idemPath ? { idempotencyKeyPath: opts.idemPath } : {}),
    secretEncrypted: authMode === 'none' ? null : encryptSecret(secret, key),
  });
  const active = opts.active ?? true;
  await setTriggersActive(pool, wf.id, active);
  await setWorkflowActive(pool, wf.id, active);
  return { workflowId: wf.id, routeKey: row.routeKey, secret };
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

describe('gateway', () => {
  test('hmac-authenticated production webhook creates an execution (202)', async () => {
    const { routeKey, secret } = await seedHook('hmac');
    const body = JSON.stringify({ event: { id: 'ev-1' }, name: 'Budi' });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sign(secret, body) },
      payload: body,
    });
    expect(r.statusCode).toBe(202);
    const { executionId, created } = r.json<{ executionId: string; created: boolean }>();
    expect(created).toBe(true);
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('CREATED');
  });

  test('stored payload has sanitized headers and body/query shape', async () => {
    const { routeKey, secret } = await seedHook('hmac');
    const body = JSON.stringify({ a: 1 });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}?src=crm`,
      headers: {
        'content-type': 'application/json',
        'x-xperiment-signature': sign(secret, body),
        authorization: 'Bearer should-vanish',
      },
      payload: body,
    });
    const { executionId } = r.json<{ executionId: string }>();
    const stored = await pool.query(
      `SELECT t.payload_json FROM trigger_events t JOIN executions e ON e.trigger_event_id = t.id WHERE e.id = $1`,
      [executionId],
    );
    const payload = (
      stored.rows[0] as {
        payload_json: { body: unknown; headers: Record<string, string>; query: Record<string, string> };
      }
    ).payload_json;
    expect(payload.body).toEqual({ a: 1 });
    expect(payload.query).toEqual({ src: 'crm' });
    expect(payload.headers['authorization']).toBeUndefined();
    expect(payload.headers['x-xperiment-signature']).toBeUndefined();
  });

  test('bad signature and bad token are 401 with no execution', async () => {
    const { routeKey } = await seedHook('hmac');
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': 'sha256=deadbeef' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
    const tok = await seedHook('token');
    const r2 = await app.inject({
      method: 'POST',
      url: `/t/${tok.routeKey}`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      payload: '{}',
    });
    expect(r2.statusCode).toBe(401);
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(0);
  });

  test('duplicate via idempotencyKeyPath dedupes (200, same execution)', async () => {
    const { routeKey } = await seedHook('none', { idemPath: 'event.id' });
    const body = JSON.stringify({ event: { id: 'same' } });
    const first = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ executionId: string }>().executionId).toBe(
      first.json<{ executionId: string }>().executionId,
    );
  });

  test('identical raw body without key path dedupes via body hash', async () => {
    const { routeKey } = await seedHook('none');
    const body = JSON.stringify({ fixed: true });
    await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(second.statusCode).toBe(200);
  });

  test('inactive trigger: production 404, test endpoint 202 with mode=test', async () => {
    const { routeKey } = await seedHook('none', { active: false });
    const prod = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: '{"x":1}',
    });
    expect(prod.statusCode).toBe(404);
    const testR = await app.inject({
      method: 'POST',
      url: `/t/test/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: '{"x":1}',
    });
    expect(testR.statusCode).toBe(202);
    const { executionId } = testR.json<{ executionId: string }>();
    const mode = await pool.query(`SELECT mode FROM executions WHERE id = $1`, [executionId]);
    expect((mode.rows[0] as { mode: string }).mode).toBe('test');
  });

  test('unknown route key 404; malformed JSON 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/t/doesnotexist',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(404);
    const { routeKey } = await seedHook('none');
    const bad = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
  });

  test('POST /r/:token resumes an open event wait with the body as output', async () => {
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Wait' });
    const ver = await createVersion(pool, { workflowId: wf.id, definition: hookIr, hash: 'h' });
    const ex = await pool.query(
      `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
       VALUES ($1,$2,$3,'RUNNING') RETURNING id`,
      [DEFAULT_WORKSPACE_ID, wf.id, ver.id],
    );
    const executionId = (ex.rows[0] as { id: string }).id;
    await pool.query(
      `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt) VALUES ($1,$2,'evt','WAITING',1)`,
      [DEFAULT_WORKSPACE_ID, executionId],
    );
    const token = randomBytes(24).toString('base64url');
    await openWait(pool, { executionId, nodeId: 'evt', attempt: 1, kind: 'event', resumeToken: token });

    const r = await app.inject({
      method: 'POST',
      url: `/r/${token}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ approvedBy: 'callback' }),
    });
    expect(r.statusCode).toBe(200);
    expect((await latestNodeStates(pool, executionId)).find((n) => n.nodeId === 'evt')?.status).toBe('SUCCEEDED');

    // Single-use: a second callback with the same token is a 404.
    const again = await app.inject({
      method: 'POST',
      url: `/r/${token}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(again.statusCode).toBe(404);
  });

  test('unknown resume token 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/r/nope', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(404);
  });

  test('the gateway refuses an approval-kind token (no auth bypass of the approval path)', async () => {
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Appr' });
    const ver = await createVersion(pool, { workflowId: wf.id, definition: hookIr, hash: 'h' });
    const ex = await pool.query(
      `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
       VALUES ($1,$2,$3,'RUNNING') RETURNING id`,
      [DEFAULT_WORKSPACE_ID, wf.id, ver.id],
    );
    const executionId = (ex.rows[0] as { id: string }).id;
    await pool.query(
      `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt) VALUES ($1,$2,'gate','WAITING',1)`,
      [DEFAULT_WORKSPACE_ID, executionId],
    );
    const token = randomBytes(24).toString('base64url');
    await openWait(pool, {
      executionId,
      nodeId: 'gate',
      attempt: 1,
      kind: 'approval',
      resumeToken: token,
      expiresAt: new Date(Date.now() + 3_600_000),
      fallback: 'reject',
      message: 'x',
    });
    const r = await app.inject({ method: 'POST', url: `/r/${token}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(404);
    // The approval is untouched — still open.
    expect((await latestNodeStates(pool, executionId)).find((n) => n.nodeId === 'gate')?.status).toBe('WAITING');
  });

  test('an oversized resume body is rejected 413, not a 500', async () => {
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Big' });
    const ver = await createVersion(pool, { workflowId: wf.id, definition: hookIr, hash: 'h' });
    const ex = await pool.query(
      `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
       VALUES ($1,$2,$3,'RUNNING') RETURNING id`,
      [DEFAULT_WORKSPACE_ID, wf.id, ver.id],
    );
    const executionId = (ex.rows[0] as { id: string }).id;
    await pool.query(
      `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt) VALUES ($1,$2,'evt','WAITING',1)`,
      [DEFAULT_WORKSPACE_ID, executionId],
    );
    const token = randomBytes(24).toString('base64url');
    await openWait(pool, { executionId, nodeId: 'evt', attempt: 1, kind: 'event', resumeToken: token });
    const big = JSON.stringify({ blob: 'x'.repeat(300_000) }); // > 256KB output cap
    const r = await app.inject({ method: 'POST', url: `/r/${token}`, headers: { 'content-type': 'application/json' }, payload: big });
    expect(r.statusCode).toBe(413);
    // The wait survives for a properly-sized retry.
    expect((await latestNodeStates(pool, executionId)).find((n) => n.nodeId === 'evt')?.status).toBe('WAITING');
  });
});
