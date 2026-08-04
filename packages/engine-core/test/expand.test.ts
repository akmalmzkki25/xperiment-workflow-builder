import type { WorkflowIR } from '@xperiment/ir';
import { describe, expect, test } from 'vitest';
import { computeReadiness, expandLoops, instanceId, isJoinId, joinId, parseInstanceId } from '../src/index.js';

/** t → lp, lp --item--> b1 → b2 (both scoped to lp), lp --done--> after */
function loopIr(): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf', name: 'wf' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      { id: 'lp', kind: 'logic', type: 'core.loop', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'b1',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: {},
        scope: { loopId: 'lp' },
      },
      {
        id: 'b2',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: {},
        scope: { loopId: 'lp' },
      },
      { id: 'after', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {} },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'lp', port: 'input' } },
      { id: 'e2', from: { nodeId: 'lp', port: 'item' }, to: { nodeId: 'b1', port: 'input' } },
      { id: 'e3', from: { nodeId: 'b1', port: 'main' }, to: { nodeId: 'b2', port: 'input' } },
      { id: 'e4', from: { nodeId: 'lp', port: 'done' }, to: { nodeId: 'after', port: 'input' } },
    ],
  };
}

describe('instance ids', () => {
  test('round-trip', () => {
    expect(instanceId('b1', 3)).toBe('b1#3');
    expect(parseInstanceId('b1#3')).toEqual({ nodeId: 'b1', iteration: 3 });
    expect(parseInstanceId(instanceId('a-node_2', 0))).toEqual({ nodeId: 'a-node_2', iteration: 0 });
  });

  test('an authored id never parses as an instance', () => {
    // The IR id pattern forbids '#', so this can never be ambiguous.
    expect(parseInstanceId('b1')).toBeNull();
    expect(parseInstanceId('b1#x')).toBeNull();
    expect(parseInstanceId('b1#-1')).toBeNull();
    expect(parseInstanceId('#3')).toBeNull();
  });

  test('join ids are recognisable and distinct', () => {
    expect(joinId('lp')).toBe('lp$join');
    expect(isJoinId('lp$join')).toBe(true);
    expect(isJoinId('lp')).toBe(false);
  });
});

describe('expandLoops', () => {
  test('an IR with no loops comes back unchanged', () => {
    const plain: WorkflowIR = {
      schemaVersion: '0.1',
      workflow: { id: 'wf', name: 'wf' },
      entrypoints: ['t'],
      nodes: [{ id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} }],
      edges: [],
    };
    expect(expandLoops(plain, {})).toEqual(plain);
  });

  test('an unexpanded loop drops its body, so no body node can run early', () => {
    const out = expandLoops(loopIr(), {});
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['after', 'lp', 't']);
    expect(out.edges.some((e) => e.to.nodeId === 'b1')).toBe(false);
    // The done edge survives untouched — an empty loop fires it directly.
    expect(out.edges.find((e) => e.id === 'e4')!.from).toEqual({ nodeId: 'lp', port: 'done' });
  });

  test('a zero-item loop emits no join and leaves done on the loop node', () => {
    const out = expandLoops(loopIr(), { lp: 0 });
    expect(out.nodes.some((n) => isJoinId(n.id))).toBe(false);
    expect(out.edges.find((e) => e.to.nodeId === 'after')!.from).toEqual({ nodeId: 'lp', port: 'done' });
  });

  test('a zero-item loop still lets the run continue', () => {
    // core.loop selects the `done` port for an empty list, so the edge fires directly.
    // Without this the join would have no inbound edges, readiness would ignore it, and the
    // execution would hang forever.
    const out = expandLoops(loopIr(), { lp: 0 });
    const r = computeReadiness(out, [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'lp', status: 'SUCCEEDED', outputPort: 'done' },
    ]);
    expect(r.ready).toEqual(['after']);
  });

  test('three iterations clone the body and its internal edges', () => {
    const out = expandLoops(loopIr(), { lp: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(out.nodes.some((n) => n.id === `b1#${i}`)).toBe(true);
      expect(out.nodes.some((n) => n.id === `b2#${i}`)).toBe(true);
      expect(out.edges.some((e) => e.from.nodeId === `b1#${i}` && e.to.nodeId === `b2#${i}`)).toBe(true);
      expect(
        out.edges.some((e) => e.from.nodeId === 'lp' && e.from.port === 'item' && e.to.nodeId === `b1#${i}`),
      ).toBe(true);
    }
    expect(out.nodes.some((n) => n.id === 'lp$join')).toBe(true);
    // done now leaves the join, not the loop.
    expect(out.edges.find((e) => e.to.nodeId === 'after')!.from.nodeId).toBe('lp$join');
  });

  test('a clone keeps the authored node settings and parameters', () => {
    const ir = loopIr();
    ir.nodes = ir.nodes.map((n) =>
      n.id === 'b1' ? { ...n, parameters: { fields: { a: 1 } }, settings: { onError: 'continue' as const } } : n,
    );
    const out = expandLoops(ir, { lp: 2 });
    const clone = out.nodes.find((n) => n.id === 'b1#1')!;
    expect(clone.parameters).toEqual({ fields: { a: 1 } });
    expect(clone.settings).toEqual({ onError: 'continue' });
    expect(clone.type).toBe('core.transform');
  });

  test('iterations never cross: b1#0 has no edge to b2#1', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    expect(out.edges.some((e) => e.from.nodeId === 'b1#0' && e.to.nodeId === 'b2#1')).toBe(false);
    expect(out.edges.some((e) => e.from.nodeId === 'b1#1' && e.to.nodeId === 'b2#0')).toBe(false);
  });

  test('the join has no inbound edges — the orchestrator seeds it', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    expect(out.edges.some((e) => e.to.nodeId === 'lp$join')).toBe(false);
  });

  test('the expanded graph schedules every iteration in parallel', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    const r = computeReadiness(out, [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'lp', status: 'SUCCEEDED', outputPort: 'item' },
    ]);
    expect(r.ready.sort()).toEqual(['b1#0', 'b1#1']);
    expect(r.terminal).toBeNull();
  });

  test('after every iteration and the join finish, the run continues to `after`', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    const r = computeReadiness(out, [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'lp', status: 'SUCCEEDED', outputPort: 'item' },
      { nodeId: 'b1#0', status: 'SUCCEEDED' },
      { nodeId: 'b2#0', status: 'SUCCEEDED' },
      { nodeId: 'b1#1', status: 'SUCCEEDED' },
      { nodeId: 'b2#1', status: 'SUCCEEDED' },
      { nodeId: 'lp$join', status: 'SUCCEEDED' },
    ]);
    expect(r.ready).toEqual(['after']);
  });

  test('the run is not terminal until the join is seeded', () => {
    const out = expandLoops(loopIr(), { lp: 1 });
    const r = computeReadiness(out, [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'lp', status: 'SUCCEEDED', outputPort: 'item' },
      { nodeId: 'b1#0', status: 'SUCCEEDED' },
      { nodeId: 'b2#0', status: 'SUCCEEDED' },
    ]);
    expect(r.terminal).toBeNull();
    expect(r.ready).toEqual([]);
  });

  test('an unhandled failure inside one iteration is still fatal', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    const r = computeReadiness(out, [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'lp', status: 'SUCCEEDED', outputPort: 'item' },
      { nodeId: 'b1#0', status: 'FAILED' },
    ]);
    // No loop-specific rule: the body node obeys its own policy, exactly as outside a loop.
    expect(r.terminal).toBe('FAILED');
  });

  test('two loops expand independently', () => {
    const ir = loopIr();
    ir.nodes.push(
      { id: 'lp2', kind: 'logic', type: 'core.loop', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'c1',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: {},
        scope: { loopId: 'lp2' },
      },
    );
    ir.edges.push(
      { id: 'e5', from: { nodeId: 'after', port: 'main' }, to: { nodeId: 'lp2', port: 'input' } },
      { id: 'e6', from: { nodeId: 'lp2', port: 'item' }, to: { nodeId: 'c1', port: 'input' } },
    );
    // Only the first loop has run.
    const out = expandLoops(ir, { lp: 2 });
    expect(out.nodes.some((n) => n.id === 'b1#0')).toBe(true);
    expect(out.nodes.some((n) => n.id === 'c1#0')).toBe(false);
    expect(out.nodes.some((n) => n.id === 'lp2$join')).toBe(false);
    expect(out.nodes.some((n) => n.id === 'lp2')).toBe(true);
  });

  test('expansion does not mutate the input', () => {
    const ir = loopIr();
    const before = JSON.stringify(ir);
    expandLoops(ir, { lp: 3 });
    expect(JSON.stringify(ir)).toBe(before);
  });
});
