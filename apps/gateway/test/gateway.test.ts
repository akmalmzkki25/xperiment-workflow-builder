import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  createPool,
  createSecretVault,
  DEFAULT_LOCAL_KEK_MASTER,
  createVersion,
  createWorkflow,
  createWorkspaceKeyring,
  DEFAULT_WORKSPACE_ID,
  deriveLegacyKey,
  encryptSecret,
  localKeyProvider,
  getExecutionDetail,
  latestNodeStates,
  openWait,
  runMigrations,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
  type SecretVault,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildGateway } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
const key = deriveLegacyKey('xperiment-dev-trigger-secret-change-me');
let triggerVault: SecretVault;

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
  triggerVault = createSecretVault({
    keyring: createWorkspaceKeyring({ pool, provider: localKeyProvider(DEFAULT_LOCAL_KEK_MASTER) }),
    legacyKey: key,
  });
  app = buildGateway({ pool, triggerVault });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE webhook_deliveries, workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

async function seedHook(
  authMode: 'none' | 'token' | 'hmac' | 'meta' | 'xendit' | 'midtrans',
  opts: { active?: boolean; idemPath?: string; envelope?: boolean } = {},
) {
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
  if (opts.envelope && authMode !== 'none') {
    // Rewrite the seeded v0 secret as v1, the format the api now produces.
    const sealed = await triggerVault.encrypt(DEFAULT_WORKSPACE_ID, secret);
    await pool.query(
      `UPDATE workflow_triggers SET secret_encrypted = $1, secret_enc_version = $2 WHERE id = $3`,
      [sealed.blob, sealed.encVersion, row.id],
    );
  }
  const active = opts.active ?? true;
  await setTriggersActive(pool, wf.id, active);
  await setWorkflowActive(pool, wf.id, active);
  return { workflowId: wf.id, routeKey: row.routeKey, secret };
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

describe('gateway probes', () => {
  test('healthz is alive without consulting anything', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });

  test('readyz names the dependency it checked', async () => {
    const r = await app.inject({ method: 'GET', url: '/readyz' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ status: string; checks: { name: string }[] }>();
    expect(body.status).toBe('ok');
    // Postgres is critical here: a gateway that cannot record a trigger event must
    // stop being sent webhooks rather than accept and drop them.
    expect(body.checks.map((c) => c.name)).toEqual(['postgres']);
  });

  test('an unknown path is still a 404 on the public surface', async () => {
    expect((await app.inject({ method: 'GET', url: '/nonsense' })).statusCode).toBe(404);
  });
});

describe('gateway envelope-encrypted trigger secrets', () => {
  test('a token webhook authenticates against a v1 secret, and a wrong one is refused', async () => {
    const { routeKey, secret } = await seedHook('token', { envelope: true });
    const ok = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      payload: { event: { id: 'e1' } },
    });
    expect(ok.statusCode).toBe(202);
    const bad = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
      payload: { event: { id: 'e2' } },
    });
    expect(bad.statusCode).toBe(401);
  });

  test('an hmac webhook authenticates against a v1 secret', async () => {
    const { routeKey, secret } = await seedHook('hmac', { envelope: true });
    const body = JSON.stringify({ event: { id: 'h1' } });
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'x-xperiment-signature': sig, 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });
});

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

describe('provider signature schemes', () => {
  test('a Meta delivery signed under X-Hub-Signature-256 is accepted', async () => {
    const { routeKey, secret } = await seedHook('meta');
    const body = JSON.stringify({ entry: [{ id: '1' }] });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret, body) },
      payload: body,
    });
    expect(r.statusCode).toBe(202);
  });

  test('the old header name does not satisfy a meta trigger', async () => {
    const { routeKey, secret } = await seedHook('meta');
    const body = JSON.stringify({ entry: [] });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sign(secret, body) },
      payload: body,
    });
    expect(r.statusCode).toBe(401);
  });

  test('a Xendit callback token is accepted, a wrong one is not', async () => {
    const { routeKey, secret } = await seedHook('xendit');
    const send = (token: string) =>
      app.inject({
        method: 'POST',
        url: `/t/${routeKey}`,
        headers: { 'content-type': 'application/json', 'x-callback-token': token },
        payload: JSON.stringify({ id: 'inv_1', status: 'PAID' }),
      });
    expect((await send(secret)).statusCode).toBe(202);
    expect((await send('wrong')).statusCode).toBe(401);
  });

  test('a Midtrans notification is verified from the digest inside the body', async () => {
    const { routeKey, secret } = await seedHook('midtrans');
    const fields = { order_id: 'INV-1', status_code: '200', gross_amount: '56000.00' };
    const signature_key = createHash('sha512')
      .update(`${fields.order_id}${fields.status_code}${fields.gross_amount}${secret}`, 'utf8')
      .digest('hex');
    const send = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: `/t/${routeKey}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
    expect((await send({ ...fields, signature_key })).statusCode).toBe(202);
    // A tampered amount must not pass, and this is the field an attacker would change.
    expect((await send({ ...fields, gross_amount: '1.00', signature_key })).statusCode).toBe(401);
  });

  test('an unimplemented auth mode fails closed rather than opening the endpoint', async () => {
    // A typo in authMode must not read as "no auth required".
    const { workflowId, routeKey } = await seedHook('hmac');
    await pool.query(`UPDATE workflow_triggers SET auth_mode = 'sha3_someday' WHERE workflow_id = $1`, [
      workflowId,
    ]);
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('the Meta subscription handshake', () => {
  const handshakeUrl = (routeKey: string, token: string, challenge = '1158201444'): string =>
    `/t/${routeKey}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${challenge}`;

  test('echoes the challenge as plain text when the token matches', async () => {
    const { routeKey, secret } = await seedHook('meta');
    const r = await app.inject({ method: 'GET', url: handshakeUrl(routeKey, secret) });
    expect(r.statusCode).toBe(200);
    // Meta compares byte for byte; a JSON wrapper fails the subscription silently.
    expect(r.body).toBe('1158201444');
    expect(r.headers['content-type']).toContain('text/plain');
  });

  test('a GET never creates an execution, even on an unauthenticated trigger', async () => {
    // The reason this is a separate handler rather than a branch: webhook URLs get pasted
    // into chat apps that fetch them automatically, and a GET that started a run would
    // fire on any crawler or link preview that touched one.
    //
    // authMode 'none' deliberately. An authenticated trigger would refuse a bare GET at
    // the auth check and this test would pass whether or not the routing was safe — which
    // is exactly what the first version of it did.
    const { workflowId, routeKey } = await seedHook('none');
    await app.inject({ method: 'GET', url: `/t/${routeKey}` });
    await app.inject({ method: 'GET', url: `/t/${routeKey}?hub.mode=subscribe` });
    await app.inject({ method: 'GET', url: handshakeUrl(routeKey, 'anything') });
    const runs = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM executions WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(Number(runs.rows[0]!.count)).toBe(0);
    const outbox = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM task_outbox`);
    expect(Number(outbox.rows[0]!.count)).toBe(0);
  });

  test('a GET on a signed trigger creates nothing either', async () => {
    const { workflowId, routeKey, secret } = await seedHook('meta');
    await app.inject({ method: 'GET', url: handshakeUrl(routeKey, secret) });
    await app.inject({ method: 'GET', url: handshakeUrl(routeKey, 'wrong') });
    const runs = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM executions WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(Number(runs.rows[0]!.count)).toBe(0);
  });

  test('a wrong verify token is a 404, indistinguishable from an unknown route key', async () => {
    // A 401 here would confirm the key exists and turn this into an enumeration oracle.
    const { routeKey, secret } = await seedHook('meta');
    const wrongToken = await app.inject({ method: 'GET', url: handshakeUrl(routeKey, 'nope') });
    const unknownKey = await app.inject({ method: 'GET', url: handshakeUrl('rk_does_not_exist', secret) });
    expect(wrongToken.statusCode).toBe(404);
    expect(unknownKey.statusCode).toBe(404);
    expect(wrongToken.json()).toEqual(unknownKey.json());
  });

  test('a trigger with no secret can never complete a handshake', async () => {
    const { routeKey } = await seedHook('none');
    expect((await app.inject({ method: 'GET', url: handshakeUrl(routeKey, '') })).statusCode).toBe(404);
  });

  test('the challenge is not a reflector for arbitrary content', async () => {
    const { routeKey, secret } = await seedHook('meta');
    const r = await app.inject({
      method: 'GET',
      url: handshakeUrl(routeKey, secret, encodeURIComponent('<script>alert(1)</script>')),
    });
    expect(r.statusCode).toBe(404);
  });

  test('works against an envelope-encrypted secret too', async () => {
    const { routeKey, secret } = await seedHook('meta', { envelope: true });
    const r = await app.inject({ method: 'GET', url: handshakeUrl(routeKey, secret) });
    expect(r.body).toBe('1158201444');
  });
});

describe('oversized deliveries', () => {
  test('a body over the storage cap is a 413, not a 500', async () => {
    // bodyLimit was 1 MB while the database caps a stored payload at 256 KB, so anything
    // between the two passed Fastify, then threw inside createExecutionWithTrigger with
    // no error handler to catch it. The provider saw a 500 and retried forever.
    const { routeKey } = await seedHook('none');
    const body = JSON.stringify({ padding: 'x'.repeat(400 * 1024) });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(r.statusCode).toBe(413);
  });

  test('a body under the cap still succeeds', async () => {
    const { routeKey } = await seedHook('none');
    const body = JSON.stringify({ padding: 'x'.repeat(100 * 1024) });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(r.statusCode).toBe(202);
  });

  test('a rejected oversized delivery leaves no half-written execution', async () => {
    const { workflowId, routeKey } = await seedHook('none');
    await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(400 * 1024) }),
    });
    const runs = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM executions WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(Number(runs.rows[0]!.count)).toBe(0);
  });
});

describe('webhook delivery diagnostics', () => {
  async function deliveries(workflowId: string) {
    const r = await pool.query<{
      outcome: string;
      status_code: number;
      auth_mode: string | null;
      headers_seen: string[];
      body_bytes: number;
      execution_id: string | null;
    }>(
      `SELECT outcome, status_code, auth_mode, headers_seen, body_bytes, execution_id
         FROM webhook_deliveries WHERE workflow_id = $1 ORDER BY received_at, id`,
      [workflowId],
    );
    return r.rows;
  }

  test('a rejected delivery is recorded, which is the whole point', async () => {
    // Before this, a provider signing under the wrong header got a 401 and left no trace
    // anywhere an operator could look. "My webhook isn't working" with zero evidence.
    const { workflowId, routeKey, secret } = await seedHook('meta');
    const body = JSON.stringify({ entry: [] });
    await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sign(secret, body) },
      payload: body,
    });
    const rows = await deliveries(workflowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('unauthorized');
    expect(rows[0]!.status_code).toBe(401);
    // The diagnostic: what the trigger expected against what actually arrived.
    expect(rows[0]!.auth_mode).toBe('meta');
    expect(rows[0]!.headers_seen).toEqual(['x-xperiment-signature']);
  });

  test('a rejected body is NEVER stored, only its size', async () => {
    // A rejected delivery is unauthenticated input. Storing it would let anyone holding a
    // route key write arbitrary content into the database and onto an operator's screen.
    const { workflowId, routeKey } = await seedHook('meta');
    const marker = 'ATTACKER-CONTROLLED-CONTENT';
    const body = JSON.stringify({ note: marker });
    await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    const raw = await pool.query<{ row: string }>(
      `SELECT webhook_deliveries::text AS row FROM webhook_deliveries WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(raw.rowCount).toBe(1);
    expect(raw.rows[0]!.row).not.toContain(marker);
    expect((await deliveries(workflowId))[0]!.body_bytes).toBe(Buffer.byteLength(body));
  });

  test('header VALUES are never stored, only names', async () => {
    const { workflowId, routeKey } = await seedHook('token');
    await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer LEAKED-TOKEN-VALUE' },
      payload: '{}',
    });
    const raw = await pool.query<{ row: string }>(
      `SELECT webhook_deliveries::text AS row FROM webhook_deliveries WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(raw.rows[0]!.row).not.toContain('LEAKED-TOKEN-VALUE');
    expect((await deliveries(workflowId))[0]!.headers_seen).toEqual(['authorization']);
  });

  test('an accepted delivery links to the execution it started', async () => {
    const { workflowId, routeKey } = await seedHook('none');
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 1 }),
    });
    const { executionId } = r.json<{ executionId: string }>();
    const rows = await deliveries(workflowId);
    expect(rows[0]!.outcome).toBe('accepted');
    expect(rows[0]!.execution_id).toBe(executionId);
  });

  test('a repeat delivery is recorded as a duplicate, not a second acceptance', async () => {
    // An operator seeing one execution for five deliveries needs to know why.
    const { workflowId, routeKey } = await seedHook('none', { idemPath: 'event.id' });
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/t/${routeKey}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ event: { id: 'same' } }),
      });
    await send();
    await send();
    expect((await deliveries(workflowId)).map((d) => d.outcome)).toEqual(['accepted', 'duplicate']);
  });

  test('malformed JSON is recorded rather than vanishing', async () => {
    const { workflowId, routeKey } = await seedHook('none');
    await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    const rows = await deliveries(workflowId);
    expect(rows[0]!.outcome).toBe('invalid_json');
    expect(rows[0]!.status_code).toBe(400);
  });

  test('an unknown route key writes nothing at all', async () => {
    // Otherwise a public endpoint lets anyone fill this table by spraying random keys —
    // unauthenticated write amplification.
    await pool.query(`DELETE FROM webhook_deliveries`);
    await app.inject({
      method: 'POST',
      url: '/t/rk_definitely_not_real',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    const count = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM webhook_deliveries`);
    expect(Number(count.rows[0]!.count)).toBe(0);
  });

  test('a GET handshake records nothing — it is not a delivery', async () => {
    const { workflowId, routeKey, secret } = await seedHook('meta');
    await app.inject({
      method: 'GET',
      url: `/t/${routeKey}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(secret)}&hub.challenge=123`,
    });
    expect(await deliveries(workflowId)).toHaveLength(0);
  });
});
