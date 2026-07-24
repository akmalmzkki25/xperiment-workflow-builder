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
  }, 90000);
});
