import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  api,
  API_URL,
  killPortOwners,
  killService,
  prepareDatabase,
  spawnService,
  waitForHealthz,
  waitForPortsFree,
  waitForTerminal,
} from './helpers.js';

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://postgres:dev_password_change_me@localhost:5432/xperiment';

let pool: Pool;
let services: ChildProcess[] = [];
let providerStub: Server;
let providerUrl: string;
const telegramMessages: { chat_id: string; text: string }[] = [];
const whatsappMessages: { to: string; type: string }[] = [];
const callbacks: { signature: string | undefined; body: { executionId: string; status: string } }[] = [];

beforeAll(async () => {
  pool = await prepareDatabase();
  await pool.query(`DROP TABLE IF EXISTS leads`);
  await pool.query(`CREATE TABLE leads (phone TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  await pool.query(`INSERT INTO leads (phone, name) VALUES ('0811111111', 'Existing Lead')`);

  // One stub plays both OpenAI and Telegram.
  providerStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url!.includes('/chat/completions')) {
        res.end(JSON.stringify({ choices: [{ message: { content: 'INTENT: purchase inquiry' } }] }));
      } else if (req.url!.includes('/sendMessage')) {
        telegramMessages.push(JSON.parse(raw) as { chat_id: string; text: string });
        res.end(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }));
      } else if (req.url!.includes('/messages')) {
        whatsappMessages.push(JSON.parse(raw) as { to: string; type: string });
        res.end(JSON.stringify({ messages: [{ id: `wamid.${whatsappMessages.length}` }] }));
      } else if (req.url!.includes('/xperiment-callback')) {
        callbacks.push({
          signature: req.headers['x-xperiment-signature'] as string | undefined,
          body: JSON.parse(raw) as { executionId: string; status: string },
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.end(JSON.stringify({ ok: true, data: [] }));
      }
    });
  });
  await new Promise<void>((r) => providerStub.listen(0, '127.0.0.1', r));
  const addr = providerStub.address();
  providerUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  await waitForPortsFree();
  services = [
    spawnService('@xperiment/api'),
    spawnService('@xperiment/orchestrator'),
    spawnService('@xperiment/worker'),
    spawnService('@xperiment/gateway'),
    spawnService('@xperiment/scheduler'),
  ];
  await waitForHealthz(`${API_URL}/v1/healthz`);
  await waitForHealthz('http://127.0.0.1:3101');
  await waitForHealthz('http://127.0.0.1:3102');
  await waitForHealthz('http://127.0.0.1:3103/healthz');
  await waitForHealthz('http://127.0.0.1:3104');
}, 120000);

afterAll(async () => {
  for (const s of services) killService(s);
  await killPortOwners();
  await new Promise<void>((r) => providerStub.close(() => r()));
  await pool.query(`DROP TABLE IF EXISTS leads`);
  await pool.end();
});

async function createConnection(connectorKey: string, name: string, payload: unknown): Promise<string> {
  const r = await api<{ id: string }>('POST', '/v1/connections', { connectorKey, name, payload });
  if (r.status !== 201) throw new Error(`connection create failed: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

describe('PRD acceptance scenario', () => {
  test('webhook -> postgres lookup -> IF -> AI classify -> telegram notify', async () => {
    const pgConn = await createConnection('postgres', 'Lead DB', { connectionString: DB_URL });
    const aiConn = await createConnection('openai', 'AI', { apiKey: 'stub-key', baseUrl: providerUrl });
    const tgConn = await createConnection('telegram', 'CS Bot', { botToken: 'stub-token', baseUrl: providerUrl });

    const definition = {
      schemaVersion: '0.1',
      workflow: { id: 'wf_accept', name: 'Lead intake' },
      entrypoints: ['hook'],
      nodes: [
        {
          id: 'hook',
          kind: 'trigger',
          type: 'webhook.trigger',
          operationVersion: '0.1.0',
          parameters: { authMode: 'hmac', idempotencyKeyPath: 'messageId' },
        },
        {
          id: 'findLead',
          kind: 'action',
          type: 'postgres.query',
          operationVersion: '0.1.0',
          parameters: { sql: 'SELECT name FROM leads WHERE phone = $1', params: ['{{ trigger.body.body.phone }}'] },
          connectionRef: pgConn,
        },
        {
          id: 'isNew',
          kind: 'logic',
          type: 'core.if',
          operationVersion: '0.1.0',
          parameters: { condition: '{{ nodes.findLead.output.rowCount == 0 }}' },
        },
        {
          id: 'classify',
          kind: 'action',
          type: 'openai.chat',
          operationVersion: '0.1.0',
          parameters: {
            prompt: 'Classify: {{ trigger.body.body.message }}',
            system: 'You classify Indonesian sales leads.',
          },
          connectionRef: aiConn,
        },
        {
          id: 'notify',
          kind: 'action',
          type: 'telegram.sendMessage',
          operationVersion: '0.1.0',
          parameters: {
            chatId: '-100200300',
            text: 'Lead baru {{ trigger.body.body.name }}: {{ nodes.classify.output.text }}',
          },
          connectionRef: tgConn,
        },
        {
          id: 'skipNote',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: { fields: { known: true, name: '{{ nodes.findLead.output.rows }}' } },
        },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'findLead', port: 'input' } },
        { id: 'e2', from: { nodeId: 'findLead', port: 'main' }, to: { nodeId: 'isNew', port: 'input' } },
        { id: 'e3', from: { nodeId: 'isNew', port: 'true' }, to: { nodeId: 'classify', port: 'input' } },
        { id: 'e4', from: { nodeId: 'classify', port: 'main' }, to: { nodeId: 'notify', port: 'input' } },
        { id: 'e5', from: { nodeId: 'isNew', port: 'false' }, to: { nodeId: 'skipNote', port: 'input' } },
      ],
    };

    const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'Lead intake' });
    await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
    const pub = await api<{ errors?: unknown[] }>('POST', `/v1/workflows/${created.body.id}/publish`);
    expect(pub.status).toBe(201);
    const act = await api<{ triggers: { url: string; secret: string }[] }>(
      'POST',
      `/v1/workflows/${created.body.id}/activate`,
    );
    const { url, secret } = act.body.triggers[0]!;

    // New lead -> true branch: classify + notify
    const newLead = JSON.stringify({
      messageId: 'm-1',
      phone: '0899999999',
      name: 'Budi Baru',
      message: 'Mau tanya harga paket',
    });
    const sig = 'sha256=' + createHmac('sha256', secret).update(Buffer.from(newLead)).digest('hex');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sig },
      body: newLead,
    });
    expect(res.status).toBe(202);
    const { executionId } = (await res.json()) as { executionId: string };
    const detail = await waitForTerminal(executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
    const byNode = new Map(detail.nodes.map((n) => [`${n.nodeId}:${n.attempt}`, n.status]));
    expect(byNode.get('classify:1')).toBe('SUCCEEDED');
    expect(byNode.get('notify:1')).toBe('SUCCEEDED');
    expect(byNode.get('skipNote:1')).toBe('SKIPPED');

    expect(telegramMessages).toHaveLength(1);
    expect(telegramMessages[0]!.chat_id).toBe('-100200300');
    expect(telegramMessages[0]!.text).toContain('Budi Baru');
    expect(telegramMessages[0]!.text).toContain('INTENT: purchase inquiry');

    // Existing lead -> false branch: no telegram message
    const existing = JSON.stringify({
      messageId: 'm-2',
      phone: '0811111111',
      name: 'Existing Lead',
      message: 'halo lagi',
    });
    const sig2 = 'sha256=' + createHmac('sha256', secret).update(Buffer.from(existing)).digest('hex');
    const res2 = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sig2 },
      body: existing,
    });
    const { executionId: exec2 } = (await res2.json()) as { executionId: string };
    const detail2 = await waitForTerminal(exec2);
    expect(detail2.execution.status).toBe('SUCCEEDED');
    const byNode2 = new Map(detail2.nodes.map((n) => [`${n.nodeId}:${n.attempt}`, n.status]));
    expect(byNode2.get('notify:1')).toBe('SKIPPED');
    expect(byNode2.get('skipNote:1')).toBe('SUCCEEDED');
    expect(telegramMessages).toHaveLength(1); // unchanged

    // Duplicate webhook (same messageId) -> same execution, no extra telegram
    const dupRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sig },
      body: newLead,
    });
    expect(dupRes.status).toBe(200);
    expect(((await dupRes.json()) as { executionId: string }).executionId).toBe(executionId);
    expect(telegramMessages).toHaveLength(1);

    // Secret hygiene: no credential material in stored node inputs or events
    const stored = await pool.query(
      `SELECT coalesce(string_agg(input_json::text, ''), '') AS inputs FROM execution_nodes WHERE execution_id = $1`,
      [executionId],
    );
    const inputs = (stored.rows[0] as { inputs: string }).inputs;
    expect(inputs).not.toContain('stub-key');
    expect(inputs).not.toContain('stub-token');
    expect(inputs).not.toContain('dev_password_change_me');

    // Usage metering (Phase 2I): the completed runs are recorded in the ledger.
    const usage = await api<{ totals: { executions: number; nodes: number; computeMs: number } }>('GET', '/v1/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.totals.executions).toBeGreaterThanOrEqual(2);
    expect(usage.body.totals.nodes).toBeGreaterThanOrEqual(1);
  }, 90000);

  test('whatsapp.sendMessage runs against the vault credential without leaking the token', async () => {
    const waConn = await createConnection('whatsapp', 'WA', {
      accessToken: 'wa-stub-secret',
      phoneNumberId: '555001',
      baseUrl: providerUrl,
    });
    const definition = {
      schemaVersion: '0.1',
      workflow: { id: 'wf_wa', name: 'WA send' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        {
          id: 'send',
          kind: 'action',
          type: 'whatsapp.sendMessage',
          operationVersion: '0.1.0',
          parameters: { to: '628123456789', text: 'Halo {{ trigger.body.name }}' },
          connectionRef: waConn,
        },
      ],
      edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'send', port: 'input' } }],
    };
    const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'WA send' });
    await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
    const pub = await api('POST', `/v1/workflows/${created.body.id}/publish`);
    expect(pub.status).toBe(201);
    const before = whatsappMessages.length;
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${created.body.id}/execute`, { name: 'Sari' });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
    expect(whatsappMessages.length).toBe(before + 1);
    expect(whatsappMessages.at(-1)!.to).toBe('628123456789');

    const stored = await pool.query(
      `SELECT coalesce(string_agg(input_json::text, ''), '') AS inputs FROM execution_nodes WHERE execution_id = $1`,
      [exec.body.executionId],
    );
    expect((stored.rows[0] as { inputs: string }).inputs).not.toContain('wa-stub-secret');
  }, 60000);

  test('completion webhook delivers a correctly-signed callback', async () => {
    const definition = {
      schemaVersion: '0.1',
      workflow: { id: 'wf_cb', name: 'CB' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        { id: 'done', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: true } } },
      ],
      edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'done', port: 'input' } }],
    };
    const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'CB' });
    await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
    await api('POST', `/v1/workflows/${created.body.id}/publish`);
    const cb = await api<{ secret: string }>('PUT', `/v1/workflows/${created.body.id}/callback`, {
      url: `${providerUrl}/xperiment-callback`,
    });
    const secret = cb.body.secret;

    const before = callbacks.length;
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${created.body.id}/execute`, {});
    await waitForTerminal(exec.body.executionId);

    const deadline = Date.now() + 15000;
    while (callbacks.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const call = callbacks.at(-1)!;
    expect(call.body.executionId).toBe(exec.body.executionId);
    expect(call.body.status).toBe('SUCCEEDED');
    const expected = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(call.body)).digest('hex');
    expect(call.signature).toBe(expected);
  }, 60000);

  test('cancel stops a suspended run and marks it CANCELED', async () => {
    const definition = {
      schemaVersion: '0.1',
      workflow: { id: 'wf_cancel', name: 'Cancel' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        { id: 'gate', kind: 'logic', type: 'core.approval', operationVersion: '0.1.0', parameters: { message: 'ok?', ttlMs: 3_600_000, fallback: 'reject' } },
      ],
      edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'gate', port: 'input' } }],
    };
    const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'Cancel' });
    await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
    await api('POST', `/v1/workflows/${created.body.id}/publish`);
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${created.body.id}/execute`, {});

    // Wait for the approval to suspend the run.
    const deadline = Date.now() + 15000;
    let status = '';
    while (Date.now() < deadline) {
      const d = await api<{ nodes: { nodeId: string; status: string }[] }>('GET', `/v1/executions/${exec.body.executionId}`);
      status = d.body.nodes.find((n) => n.nodeId === 'gate')?.status ?? '';
      if (status === 'WAITING') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe('WAITING');

    const cancel = await api('POST', `/v1/executions/${exec.body.executionId}/cancel`);
    expect(cancel.status).toBe(200);
    const detail = await api<{ execution: { status: string }; waits: { status: string }[] }>(
      'GET',
      `/v1/executions/${exec.body.executionId}`,
    );
    expect(detail.body.execution.status).toBe('CANCELED');
    expect(detail.body.waits.every((w) => w.status !== 'open')).toBe(true);
  }, 60000);
});
