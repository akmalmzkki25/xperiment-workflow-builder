import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createPool, deriveLegacyKey, encryptSecret, runMigrations, setWorkflowCallback } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runCallback, type CallbackDeps } from '../src/callback.js';
import { truncateAll } from './helpers.js';

let pool: Pool;
let deps: CallbackDeps;
const triggerKey = deriveLegacyKey('xperiment-dev-trigger-secret-change-me');

let server: Server;
let baseUrl: string;
let received: { sig: string | undefined; body: unknown }[] = [];
let respStatus = 200;

async function seedExecution(url: string | null, secret: string | null, status = 'SUCCEEDED'): Promise<string> {
  const wf = await pool.query(
    `INSERT INTO workflows (workspace_id, name, completion_webhook_url, completion_webhook_secret_encrypted)
     VALUES ('00000000-0000-0000-0000-000000000001','w',$1,$2) RETURNING id`,
    [url, secret ? encryptSecret(secret, triggerKey) : null],
  );
  const workflowId = (wf.rows[0] as { id: string }).id;
  const ver = await pool.query(
    `INSERT INTO workflow_versions (workspace_id, workflow_id, version_number, definition_json, definition_hash)
     VALUES ('00000000-0000-0000-0000-000000000001',$1,1,'{}'::jsonb,'h') RETURNING id`,
    [workflowId],
  );
  const ex = await pool.query(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, completed_at)
     VALUES ('00000000-0000-0000-0000-000000000001',$1,$2,$3, now()) RETURNING id`,
    [workflowId, (ver.rows[0] as { id: string }).id, status],
  );
  return (ex.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  deps = { pool, triggerKey, allowPrivateIps: true, log: () => {} };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      received.push({ sig: req.headers['x-xperiment-signature'] as string | undefined, body: JSON.parse(raw) });
      res.statusCode = respStatus;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  received = [];
  respStatus = 200;
});

describe('runCallback', () => {
  test('POSTs a body signed with the workflow secret', async () => {
    const secret = randomBytes(16).toString('hex');
    const executionId = await seedExecution(`${baseUrl}/hook`, secret);
    await runCallback(deps, { executionId });
    expect(received).toHaveLength(1);
    const body = JSON.stringify(received[0]!.body);
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(received[0]!.sig).toBe(expected);
    expect((received[0]!.body as { status: string }).status).toBe('SUCCEEDED');
  });

  test('throws on a non-2xx so BullMQ retries', async () => {
    respStatus = 500;
    const executionId = await seedExecution(`${baseUrl}/hook`, randomBytes(8).toString('hex'));
    await expect(runCallback(deps, { executionId })).rejects.toThrow(/500/);
  });

  test('SSRF-blocks a private URL when private IPs are disallowed', async () => {
    const strictDeps: CallbackDeps = { ...deps, allowPrivateIps: false };
    const executionId = await seedExecution('http://127.0.0.1:9/hook', randomBytes(8).toString('hex'));
    await expect(runCallback(strictDeps, { executionId })).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(received).toHaveLength(0);
  });

  test('no-ops when the callback was cleared after enqueue', async () => {
    const executionId = await seedExecution(null, null);
    await runCallback(deps, { executionId });
    expect(received).toHaveLength(0);
  });

  test('no-ops (does not throw) for an unknown execution id', async () => {
    // A poison/stale job or a hard-deleted execution must not wedge the queue.
    await expect(runCallback(deps, { executionId: randomUUID() })).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
  });
});
