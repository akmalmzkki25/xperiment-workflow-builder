import { createHmac } from 'node:crypto';
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

const GATEWAY_URL = 'http://127.0.0.1:3103';

let pool: Pool;
let services: ChildProcess[] = [];

function webhookIr() {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_hook', name: 'Hook' },
    entrypoints: ['hook'],
    nodes: [
      {
        id: 'hook',
        kind: 'trigger',
        type: 'webhook.trigger',
        operationVersion: '0.1.0',
        parameters: { authMode: 'hmac', idempotencyKeyPath: 'event.id' },
      },
      {
        id: 'shape',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { lead: '{{ trigger.body.body.name }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'shape', port: 'input' } }],
  };
}

function scheduleIr() {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_cron', name: 'Cron' },
    entrypoints: ['tick'],
    nodes: [
      {
        id: 'tick',
        kind: 'trigger',
        type: 'schedule.trigger',
        operationVersion: '0.1.0',
        parameters: { cron: '* * * * * *', timezone: 'UTC' },
      },
      {
        id: 'stamp',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { at: '{{ trigger.body.scheduledFor }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'tick', port: 'main' }, to: { nodeId: 'stamp', port: 'input' } }],
  };
}

async function publishedAndActivated(
  definition: unknown,
): Promise<{ id: string; url: string; testUrl: string; secret: string | null }> {
  const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'trigger-e2e' });
  await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
  const pub = await api('POST', `/v1/workflows/${created.body.id}/publish`);
  if (pub.status !== 201) throw new Error(`publish failed: ${JSON.stringify(pub.body)}`);
  const act = await api<{ triggers: { url?: string; testUrl?: string; secret?: string | null }[] }>(
    'POST',
    `/v1/workflows/${created.body.id}/activate`,
  );
  const t = act.body.triggers[0]!;
  return { id: created.body.id, url: t.url ?? '', testUrl: t.testUrl ?? '', secret: t.secret ?? null };
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

async function hook(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: { executionId: string; created: boolean } }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: res.status, body: (await res.json()) as { executionId: string; created: boolean } };
}

beforeAll(async () => {
  pool = await prepareDatabase();
  await waitForPortsFree();
  services = [
    spawnService('@xperiment/api'),
    spawnService('@xperiment/orchestrator'),
    spawnService('@xperiment/worker'),
    spawnService('@xperiment/gateway'),
    spawnService('@xperiment/scheduler'),
  ];
  await waitForHealthz(`${API_URL}/v1/healthz`);
  await waitForHealthz('http://127.0.0.1:3101/healthz');
  await waitForHealthz('http://127.0.0.1:3102/healthz');
  await waitForHealthz(`${GATEWAY_URL}/healthz`);
  await waitForHealthz('http://127.0.0.1:3104/healthz');
}, 120000);

afterAll(async () => {
  for (const s of services) killService(s);
  await killPortOwners();
  await pool.end();
});

describe('trigger e2e', () => {
  test('signed production webhook drives a full execution', async () => {
    const wf = await publishedAndActivated(webhookIr());
    const body = JSON.stringify({ event: { id: 'lead-1' }, name: 'Budi' });
    const r = await hook(wf.url, body, { 'x-xperiment-signature': sign(wf.secret!, body) });
    expect(r.status).toBe(202);
    const detail = await waitForTerminal(r.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
  });

  test('bad signature is rejected with no execution', async () => {
    const wf = await publishedAndActivated(webhookIr());
    const r = await fetch(wf.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': 'sha256=bad' },
      body: '{"event":{"id":"x"}}',
    });
    expect(r.status).toBe(401);
  });

  test('duplicate delivery with same event id yields one execution', async () => {
    const wf = await publishedAndActivated(webhookIr());
    const body = JSON.stringify({ event: { id: 'dup-1' }, name: 'Sari' });
    const h = { 'x-xperiment-signature': sign(wf.secret!, body) };
    const first = await hook(wf.url, body, h);
    const second = await hook(wf.url, body, h);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.executionId).toBe(first.body.executionId);
  });

  test('deactivate stops production URL but test URL still works', async () => {
    const wf = await publishedAndActivated(webhookIr());
    await api('POST', `/v1/workflows/${wf.id}/deactivate`);
    const body = JSON.stringify({ event: { id: 'post-deactivate' } });
    const prod = await fetch(wf.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sign(wf.secret!, body) },
      body,
    });
    expect(prod.status).toBe(404);
    const testR = await hook(wf.testUrl, body, { 'x-xperiment-signature': sign(wf.secret!, body) });
    expect(testR.status).toBe(202);
    const detail = await waitForTerminal(testR.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
  });

  test('seconds-cron schedule fires a real execution', async () => {
    const wf = await publishedAndActivated(scheduleIr());
    const deadline = Date.now() + 20000;
    let found: { items: { id: string }[] } | null = null;
    for (;;) {
      const list = await api<{ items: { id: string }[] }>('GET', `/v1/executions?workflowId=${wf.id}&limit=5`);
      if (list.body.items.length > 0) {
        found = list.body;
        break;
      }
      if (Date.now() > deadline) throw new Error('schedule never fired');
      await new Promise((r) => setTimeout(r, 500));
    }
    const detail = await waitForTerminal(found.items[0]!.id);
    expect(detail.execution.status).toBe('SUCCEEDED');
    await api('POST', `/v1/workflows/${wf.id}/deactivate`); // stop firing for the rest of the suite
  });
});
