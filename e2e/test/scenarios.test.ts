import type { ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  api,
  API_URL,
  createPublishedWorkflow,
  killPortOwners,
  killService,
  leadCheckIr,
  prepareDatabase,
  spawnService,
  startStubServer,
  waitForHealthz,
  waitForPortsFree,
  waitForTerminal,
  type StubServer,
} from './helpers.js';

let pool: Pool;
let stub: StubServer;
let services: ChildProcess[] = [];

beforeAll(async () => {
  pool = await prepareDatabase();
  stub = await startStubServer();
  await waitForPortsFree();
  services = [spawnService('@xperiment/api'), spawnService('@xperiment/orchestrator'), spawnService('@xperiment/worker')];
  await waitForHealthz(`${API_URL}/v1/healthz`);
  await waitForHealthz('http://127.0.0.1:3101');
  await waitForHealthz('http://127.0.0.1:3102');
}, 120000);

afterAll(async () => {
  for (const s of services) killService(s);
  await killPortOwners();
  await stub.close();
  await pool.end();
});

describe('phase-0 end-to-end', () => {
  test('happy path: true branch calls the stub, false subtree skipped', async () => {
    const wfId = await createPublishedWorkflow(leadCheckIr(stub.url));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {
      name: 'Budi',
      total: 150,
    });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
    const byNode = new Map(detail.nodes.map((n) => [n.nodeId + ':' + n.attempt, n.status]));
    expect(byNode.get('notify:1')).toBe('SUCCEEDED');
    expect(byNode.get('archive:1')).toBe('SKIPPED');
    expect(stub.received.some((r) => r.path === '/notify' && (r.body as { name: string }).name === 'Budi')).toBe(
      true,
    );
  });

  test('false branch: transform runs, http node skipped', async () => {
    const wfId = await createPublishedWorkflow(leadCheckIr(stub.url));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {
      name: 'Sari',
      total: 50,
    });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
    const byNode = new Map(detail.nodes.map((n) => [n.nodeId + ':' + n.attempt, n.status]));
    expect(byNode.get('archive:1')).toBe('SUCCEEDED');
    expect(byNode.get('notify:1')).toBe('SKIPPED');
  });

  test('retry: 500,500,200 produces three recorded attempts then success', async () => {
    stub.setResponses('/notify', [500, 500, 200]);
    const wfId = await createPublishedWorkflow(leadCheckIr(stub.url));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {
      name: 'Retry',
      total: 200,
    });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
    const notifyAttempts = detail.nodes.filter((n) => n.nodeId === 'notify').sort((a, b) => a.attempt - b.attempt);
    expect(notifyAttempts.map((n) => n.status)).toEqual(['RETRY_SCHEDULED', 'RETRY_SCHEDULED', 'SUCCEEDED']);
  });

  test('retry exhaustion: persistent 500 fails the execution after 3 attempts', async () => {
    stub.setResponses('/notify', [500, 500, 500]);
    const wfId = await createPublishedWorkflow(leadCheckIr(stub.url));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {
      name: 'Doom',
      total: 200,
    });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('FAILED');
    const notifyAttempts = detail.nodes.filter((n) => n.nodeId === 'notify');
    expect(notifyAttempts).toHaveLength(3);
    expect(notifyAttempts.find((n) => n.attempt === 3)?.status).toBe('FAILED');
  });

  test('duplicate Idempotency-Key never creates a second execution', async () => {
    const wfId = await createPublishedWorkflow(leadCheckIr(stub.url));
    const first = await api<{ executionId: string }>(
      'POST',
      `/v1/workflows/${wfId}/execute`,
      { name: 'Dup', total: 10 },
      { 'idempotency-key': 'e2e-dup' },
    );
    const second = await api<{ executionId: string; created: boolean }>(
      'POST',
      `/v1/workflows/${wfId}/execute`,
      { name: 'Dup', total: 10 },
      { 'idempotency-key': 'e2e-dup' },
    );
    expect(second.status).toBe(200);
    expect(second.body.executionId).toBe(first.body.executionId);
    expect(second.body.created).toBe(false);
    await waitForTerminal(first.body.executionId);
  });

  test('invalid IR is rejected at publish with structured findings', async () => {
    const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'bad' });
    const broken = leadCheckIr(stub.url) as { edges: { from: { nodeId: string } }[] };
    broken.edges[0]!.from.nodeId = 'ghost';
    await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition: broken }, { 'if-match': '1' });
    const publish = await api<{ errors: { code: string }[] }>('POST', `/v1/workflows/${created.body.id}/publish`);
    expect(publish.status).toBe(422);
    expect(publish.body.errors.some((e) => e.code === 'unknown_edge_node')).toBe(true);
  });

  test('EXIT CRITERION: same workflow + same input x5 -> identical terminal results', async () => {
    const wfId = await createPublishedWorkflow(leadCheckIr(stub.url));
    const results: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const exec = await api<{ executionId: string }>(
        'POST',
        `/v1/workflows/${wfId}/execute`,
        { name: 'Det', total: 150 },
        { 'idempotency-key': `det-${i}` },
      );
      const detail = await waitForTerminal(exec.body.executionId);
      const signature =
        detail.execution.status +
        '|' +
        detail.nodes
          .map((n) => `${n.nodeId}:${n.attempt}:${n.status}`)
          .sort()
          .join(',');
      results.push(signature);
    }
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toContain('SUCCEEDED');
  });
});

describe('loops and error paths', () => {
  /** manual trigger → loop(3 items) → [double] → after */
  function loopIr(concurrency: number): unknown {
    return {
      schemaVersion: '0.1',
      workflow: { id: 'wf_loop_e2e', name: 'Loop e2e' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        {
          id: 'lp',
          kind: 'logic',
          type: 'core.loop',
          operationVersion: '0.1.0',
          parameters: { items: '{{ trigger.body.rows }}', concurrency },
        },
        {
          id: 'double',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: { fields: { seen: '{{ loop.item }}', at: '{{ loop.index }}' } },
          scope: { loopId: 'lp' },
        },
        {
          id: 'after',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: { fields: { done: true } },
        },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'lp', port: 'input' } },
        { id: 'e2', from: { nodeId: 'lp', port: 'item' }, to: { nodeId: 'double', port: 'input' } },
        { id: 'e3', from: { nodeId: 'lp', port: 'done' }, to: { nodeId: 'after', port: 'input' } },
      ],
    };
  }

  test('three items run as three instances, each seeing its own item', async () => {
    const wfId = await createPublishedWorkflow(loopIr(1));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {
      rows: ['a', 'b', 'c'],
    });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');

    const byNode = new Map(detail.nodes.map((n) => [n.nodeId, n.status]));
    for (let i = 0; i < 3; i += 1) expect(byNode.get(`double#${i}`)).toBe('SUCCEEDED');
    // The authored body id never runs; only its instances do.
    expect(byNode.has('double')).toBe(false);
    expect(byNode.get('lp$join')).toBe('SUCCEEDED');
    expect(byNode.get('after')).toBe('SUCCEEDED');
    expect(detail.events.map((e) => e.eventType)).toContain('loop.completed');
  });

  test('each iteration resolves loop.item to its own element', async () => {
    const wfId = await createPublishedWorkflow(loopIr(2));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, {
      rows: ['x', 'y'],
    });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
    // The execution-detail endpoint does not expose node outputs, so read them directly.
    const rows = await pool.query<{ node_id: string; output_json: { seen?: unknown; at?: unknown } }>(
      `SELECT node_id, output_json FROM execution_nodes
       WHERE execution_id = $1 AND node_id LIKE 'double#%' ORDER BY node_id`,
      [exec.body.executionId],
    );
    expect(rows.rows.map((r) => r.output_json)).toEqual([
      { seen: 'x', at: 0 },
      { seen: 'y', at: 1 },
    ]);
  });

  test('an empty list skips the body and still reaches the node after the loop', async () => {
    const wfId = await createPublishedWorkflow(loopIr(1));
    const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, { rows: [] });
    const detail = await waitForTerminal(exec.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
    expect(detail.nodes.some((n) => n.nodeId.startsWith('double#'))).toBe(false);
    expect(detail.nodes.find((n) => n.nodeId === 'after')?.status).toBe('SUCCEEDED');
  });
});
