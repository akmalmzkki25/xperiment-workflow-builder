import { describe, expect, test } from 'vitest';
import { diffWorkflows } from '../src/diff.js';
import type { WorkflowIR } from '../src/types.js';

const base: WorkflowIR = {
  schemaVersion: '0.1',
  workflow: { id: 'wf', name: 'W' },
  entrypoints: ['t'],
  nodes: [
    { id: 't', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'none' } },
    { id: 'a', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: true } } },
  ],
  edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'a', port: 'input' } }],
};
const clone = (ir: WorkflowIR): WorkflowIR => JSON.parse(JSON.stringify(ir)) as WorkflowIR;

describe('diffWorkflows', () => {
  test('identical IRs report no changes', () => {
    const d = diffWorkflows(base, clone(base));
    expect(d.changed).toBe(false);
    expect(d.nodes).toEqual({ added: [], removed: [], modified: [] });
    expect(d.edges).toEqual({ added: [], removed: [], modified: [] });
  });

  test('added and removed nodes', () => {
    const to = clone(base);
    to.nodes.push({ id: 'b', kind: 'action', type: 'http.request', operationVersion: '0.1.0', parameters: {} });
    to.nodes = to.nodes.filter((n) => n.id !== 'a');
    const d = diffWorkflows(base, to);
    expect(d.nodes.added).toEqual(['b']);
    expect(d.nodes.removed).toEqual(['a']);
    expect(d.changed).toBe(true);
  });

  test('modified node reports only the changed fields (params-only, key-order stable)', () => {
    const to = clone(base);
    to.nodes[1]!.parameters = { fields: { ok: false } };
    const d = diffWorkflows(base, to);
    expect(d.nodes.modified).toEqual([{ nodeId: 'a', changedFields: ['parameters'] }]);

    const reordered = clone(base);
    reordered.nodes[0]!.parameters = { authMode: 'none' }; // same content, treated equal
    expect(diffWorkflows(base, reordered).changed).toBe(false);
  });

  test('nested parameter key reordering is not a change (recursive stable stringify)', () => {
    const from = clone(base);
    from.nodes[1]!.parameters = { cfg: { a: 1, b: 2 }, list: [{ x: 1, y: 2 }] };
    const to = clone(base);
    to.nodes[1]!.parameters = { list: [{ y: 2, x: 1 }], cfg: { b: 2, a: 1 } }; // same content, keys reordered at every level
    expect(diffWorkflows(from, to).changed).toBe(false);
  });

  test('a kind-only change and an operationVersion-only change are each detected', () => {
    const kindOnly = clone(base);
    kindOnly.nodes[1]!.kind = 'action';
    expect(diffWorkflows(base, kindOnly).nodes.modified).toEqual([{ nodeId: 'a', changedFields: ['kind'] }]);

    const opVersionOnly = clone(base);
    opVersionOnly.nodes[1]!.operationVersion = '0.2.0';
    expect(diffWorkflows(base, opVersionOnly).nodes.modified).toEqual([{ nodeId: 'a', changedFields: ['operationVersion'] }]);
  });

  test('type + connectionRef changes are listed', () => {
    const to = clone(base);
    to.nodes[1]!.type = 'postgres.query';
    to.nodes[1]!.connectionRef = 'conn-1';
    const d = diffWorkflows(base, to);
    expect(d.nodes.modified[0]!.changedFields.sort()).toEqual(['connectionRef', 'type']);
  });

  test('edge added / removed / rewired', () => {
    const added = clone(base);
    added.edges.push({ id: 'e2', from: { nodeId: 'a', port: 'main' }, to: { nodeId: 't', port: 'input' } });
    expect(diffWorkflows(base, added).edges.added).toEqual(['e2']);

    const removed = clone(base);
    removed.edges = [];
    expect(diffWorkflows(base, removed).edges.removed).toEqual(['e1']);

    const rewired = clone(base);
    rewired.edges[0]!.to = { nodeId: 'a', port: 'other' };
    expect(diffWorkflows(base, rewired).edges.modified).toEqual([{ edgeId: 'e1' }]);
  });
});
