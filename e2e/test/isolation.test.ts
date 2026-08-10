import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  API_URL,
  killPortOwners,
  killService,
  prepareDatabase,
  spawnService,
  waitForHealthz,
  waitForPortsFree,
} from './helpers.js';

let pool: Pool;
let services: ChildProcess[] = [];

const manualIr = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_iso', name: 'Iso' },
  entrypoints: ['t'],
  nodes: [
    { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
    {
      id: 'echo',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: { ok: true } },
    },
  ],
  edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
};

interface UserSession {
  token: string;
  call: <T>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

async function registerUser(): Promise<UserSession> {
  const res = await fetch(`${API_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `iso-${randomUUID()}@xperiment.test`, password: 'password-123' }),
  });
  const { token } = (await res.json()) as { token: string };
  return {
    token,
    call: async <T>(method: string, path: string, body?: unknown) => {
      const r = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: (text.length > 0 ? JSON.parse(text) : null) as T };
    },
  };
}

beforeAll(async () => {
  pool = await prepareDatabase();
  await waitForPortsFree();
  services = [spawnService('@xperiment/api'), spawnService('@xperiment/orchestrator'), spawnService('@xperiment/worker')];
  await waitForHealthz(`${API_URL}/v1/healthz`);
  await waitForHealthz('http://127.0.0.1:3101/healthz');
  await waitForHealthz('http://127.0.0.1:3102/healthz');
}, 120000);

afterAll(async () => {
  for (const s of services) killService(s);
  await killPortOwners();
  await pool.end();
});

describe('two-user end-to-end isolation', () => {
  test('each user sees only their own workflows and executions', async () => {
    const alice = await registerUser();
    const bob = await registerUser();

    const setupUser = async (u: UserSession) => {
      const wf = await u.call<{ id: string }>('POST', '/v1/workflows', { name: 'mine' });
      const draft = await fetch(`${API_URL}/v1/workflows/${wf.body.id}/draft`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${u.token}`,
          'if-match': '1',
        },
        body: JSON.stringify({ definition: manualIr }),
      });
      if (draft.status !== 200) throw new Error(`draft failed ${draft.status}`);
      const pub = await u.call<{ versionNumber: number }>('POST', `/v1/workflows/${wf.body.id}/publish`);
      if (pub.status !== 201) throw new Error(`publish failed ${JSON.stringify(pub.body)}`);
      const exec = await u.call<{ executionId: string }>('POST', `/v1/workflows/${wf.body.id}/execute`, {});
      return { workflowId: wf.body.id, executionId: exec.body.executionId };
    };

    const a = await setupUser(alice);
    const b = await setupUser(bob);

    // Executions complete for both.
    const detailA = await pollTerminal(alice, a.executionId);
    const detailB = await pollTerminal(bob, b.executionId);
    expect(detailA).toBe('SUCCEEDED');
    expect(detailB).toBe('SUCCEEDED');

    // Lists are disjoint.
    const aList = await alice.call<{ items: { id: string }[] }>('GET', '/v1/workflows');
    const bList = await bob.call<{ items: { id: string }[] }>('GET', '/v1/workflows');
    expect(aList.body.items.map((w) => w.id)).toEqual([a.workflowId]);
    expect(bList.body.items.map((w) => w.id)).toEqual([b.workflowId]);
    const aExecs = await alice.call<{ items: { id: string }[] }>('GET', '/v1/executions');
    expect(aExecs.body.items.map((e) => e.id)).toEqual([a.executionId]);

    // Cross access is 404.
    expect((await bob.call('GET', `/v1/workflows/${a.workflowId}`)).status).toBe(404);
    expect((await alice.call('GET', `/v1/executions/${b.executionId}`)).status).toBe(404);
  }, 60000);
});

async function pollTerminal(u: UserSession, executionId: string): Promise<string> {
  const deadline = Date.now() + 30000;
  for (;;) {
    const { body } = await u.call<{ execution: { status: string } }>('GET', `/v1/executions/${executionId}`);
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(body.execution.status)) return body.execution.status;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}
