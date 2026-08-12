import type { ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  api,
  API_URL,
  createPublishedWorkflow,
  killPortOwners,
  killService,
  prepareDatabase,
  spawnService,
  waitForHealthz,
  waitForPortsFree,
  waitForTerminal,
} from './helpers.js';

/**
 * The data-shaping nodes through a real run.
 *
 * They have thorough unit tests, but a unit test calls `run()` directly. It cannot catch
 * a node that resolves its parameters wrongly through `resolveTemplate`, routes to a port
 * the scheduler does not recognise, or produces an output the next node cannot read.
 * Every assertion here is on what the orchestrator actually recorded.
 */

let pool: Pool;
let services: ChildProcess[] = [];

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

const trigger = {
  id: 'start',
  kind: 'trigger',
  type: 'manual.trigger',
  operationVersion: '0.1.0',
  parameters: {},
};

function node(id: string, type: string, parameters: unknown): Record<string, unknown> {
  return { id, kind: 'logic', type, operationVersion: '0.1.0', parameters };
}

function edge(from: string, port: string, to: string): Record<string, unknown> {
  return { id: `e_${from}_${port}_${to}`, from: { nodeId: from, port }, to: { nodeId: to, port: 'input' } };
}

function ir(name: string, nodes: unknown[], edges: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: '0.1',
    workflow: { id: `wf_${name}`, name },
    entrypoints: ['start'],
    nodes: [trigger, ...nodes],
    edges,
  };
}

async function run(definition: Record<string, unknown>, input: unknown) {
  const wfId = await createPublishedWorkflow(definition);
  const exec = await api<{ executionId: string }>('POST', `/v1/workflows/${wfId}/execute`, input);
  return waitForTerminal(exec.body.executionId);
}

/** Node status by authored id, first attempt. */
function statuses(detail: { nodes: { nodeId: string; attempt: number; status: string }[] }): Map<string, string> {
  return new Map(detail.nodes.filter((n) => n.attempt === 1).map((n) => [n.nodeId, n.status]));
}

const ORDERS = [
  { sku: 'KRP-500', name: 'Keripik singkong', price: 28000, qty: 2 },
  { sku: 'SBL-250', name: 'Sambal roa', price: 45000, qty: 1 },
  { sku: 'KCG-100', name: 'Kacang telur', price: 12000, qty: 3 },
];

describe('data-shaping nodes end to end', () => {
  test('filter, sort, limit and aggregate chain through a real run', async () => {
    const definition = ir(
      'shape',
      [
        node('mahal', 'core.filter', { items: '{{ trigger.body.orders }}', field: 'price', op: 'gte', value: 20000 }),
        node('urut', 'core.sort', { items: '{{ nodes.mahal.output.items }}', field: 'price', direction: 'desc' }),
        node('teratas', 'core.limit', { items: '{{ nodes.urut.output.items }}', count: 1 }),
        node('total', 'core.aggregate', {
          items: '{{ trigger.body.orders }}',
          operation: 'sum',
          field: 'price',
        }),
      ],
      [edge('start', 'main', 'mahal'), edge('mahal', 'main', 'urut'), edge('urut', 'main', 'teratas'), edge('start', 'main', 'total')],
    );
    const detail = await run(definition, { orders: ORDERS });
    expect(detail.execution.status).toBe('SUCCEEDED');
    const byNode = statuses(detail);
    for (const id of ['mahal', 'urut', 'teratas', 'total']) expect(byNode.get(id), id).toBe('SUCCEEDED');
  });

  test('an empty filter result takes the empty port, not the main one', async () => {
    // The `empty` port is what makes core.filter composable — without it every author
    // writes a core.if over `length(...) == 0`.
    const definition = ir(
      'empty',
      [
        node('mahal', 'core.filter', {
          items: '{{ trigger.body.orders }}',
          field: 'price',
          op: 'gte',
          value: 999999,
        }),
        node('ada', 'core.transform', { fields: { jalur: 'main' } }),
        node('kosong', 'core.transform', { fields: { jalur: 'empty' } }),
      ],
      [edge('start', 'main', 'mahal'), edge('mahal', 'main', 'ada'), edge('mahal', 'empty', 'kosong')],
    );
    const detail = await run(definition, { orders: ORDERS });
    expect(detail.execution.status).toBe('SUCCEEDED');
    const byNode = statuses(detail);
    expect(byNode.get('kosong')).toBe('SUCCEEDED');
    expect(byNode.get('ada')).toBe('SKIPPED');
  });

  test('switch routes to a case, and the unfired ports are skipped rather than hanging', async () => {
    // The readiness fixpoint has to mark every branch off an unfired port SKIPPED. If it
    // did not, the run would sit at RUNNING with an empty ready set until the watchdog.
    const definition = ir(
      'switch',
      [
        node('pilih', 'core.switch', {
          value: '{{ trigger.body.status }}',
          cases: [{ equals: 'PAID' }, { equals: 'PENDING' }],
        }),
        node('lunas', 'core.transform', { fields: { jalur: 'paid' } }),
        node('menunggu', 'core.transform', { fields: { jalur: 'pending' } }),
        node('lainnya', 'core.transform', { fields: { jalur: 'default' } }),
      ],
      [
        edge('start', 'main', 'pilih'),
        edge('pilih', 'case1', 'lunas'),
        edge('pilih', 'case2', 'menunggu'),
        edge('pilih', 'default', 'lainnya'),
      ],
    );
    const detail = await run(definition, { status: 'PENDING' });
    expect(detail.execution.status).toBe('SUCCEEDED');
    const byNode = statuses(detail);
    expect(byNode.get('menunggu')).toBe('SUCCEEDED');
    expect(byNode.get('lunas')).toBe('SKIPPED');
    expect(byNode.get('lainnya')).toBe('SKIPPED');
  });

  test('a fan-in behind a switch fires once the skipped branches are decided', async () => {
    // core.merge needed no scheduler change, and this is the proof: the join sees one
    // active predecessor and two decided-inactive ones, and runs.
    const definition = ir(
      'merge',
      [
        node('pilih', 'core.switch', { value: '{{ trigger.body.status }}', cases: [{ equals: 'PAID' }] }),
        node('lunas', 'core.transform', { fields: { jalur: 'paid' } }),
        node('lainnya', 'core.transform', { fields: { jalur: 'default' } }),
        node('gabung', 'core.merge', {
          mode: 'append',
          sources: ['{{ nodes.lunas.output }}', '{{ nodes.lainnya.output }}'],
        }),
      ],
      [
        edge('start', 'main', 'pilih'),
        edge('pilih', 'case1', 'lunas'),
        edge('pilih', 'default', 'lainnya'),
        edge('lunas', 'main', 'gabung'),
        edge('lainnya', 'main', 'gabung'),
      ],
    );
    const detail = await run(definition, { status: 'PAID' });
    expect(detail.execution.status).toBe('SUCCEEDED');
    const byNode = statuses(detail);
    expect(byNode.get('gabung')).toBe('SUCCEEDED');
    expect(byNode.get('lainnya')).toBe('SKIPPED');
  });

  test('splitBatch feeds core.loop, one batch per iteration', async () => {
    // The composition the split node exists for. Without numeric indexing in expressions
    // a loop body could not reach inside its own batch at all.
    const definition = ir(
      'batches',
      [
        node('bagi', 'core.splitBatch', { items: '{{ trigger.body.orders }}', size: 2 }),
        {
          id: 'ulangi',
          kind: 'logic',
          type: 'core.loop',
          operationVersion: '0.1.0',
          parameters: { items: '{{ nodes.bagi.output.batches }}' },
        },
        {
          ...node('proses', 'core.transform', { fields: { pertama: '{{ loop.item[0].sku }}' } }),
          scope: { loopId: 'ulangi' },
        },
        node('selesai', 'core.transform', { fields: { jumlah: '{{ nodes.ulangi.output.count }}' } }),
      ],
      [
        edge('start', 'main', 'bagi'),
        edge('bagi', 'main', 'ulangi'),
        edge('ulangi', 'item', 'proses'),
        edge('ulangi', 'done', 'selesai'),
      ],
    );
    const detail = await run(definition, { orders: ORDERS });
    expect(detail.execution.status).toBe('SUCCEEDED');
    // Three orders at two per batch is two iterations, so two body instances ran.
    const bodyRuns = detail.nodes.filter((n) => n.nodeId.startsWith('proses#') && n.status === 'SUCCEEDED');
    expect(bodyRuns).toHaveLength(2);
    expect(statuses(detail).get('selesai')).toBe('SUCCEEDED');
  });

  test('stopAndError ends the run as FAILED with the author own code', async () => {
    const definition = ir(
      'stop',
      [
        node('cek', 'core.if', { condition: '{{ trigger.body.total < 1 }}' }),
        node('berhenti', 'core.stopAndError', { code: 'pesanan_kosong', message: 'Pesanan tidak berisi apa pun' }),
        node('lanjut', 'core.transform', { fields: { ok: true } }),
      ],
      [edge('start', 'main', 'cek'), edge('cek', 'true', 'berhenti'), edge('cek', 'false', 'lanjut')],
    );
    const detail = await run(definition, { total: 0 });
    expect(detail.execution.status).toBe('FAILED');
    const byNode = statuses(detail);
    expect(byNode.get('berhenti')).toBe('FAILED');
    expect(byNode.get('lanjut')).toBe('SKIPPED');
  });
});
