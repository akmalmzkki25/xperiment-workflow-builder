import type { WorkflowIR } from '@xperiment/ir';
import { describe, expect, test } from 'vitest';
import { computeReadiness, type NodeOutcome } from '../src/index.js';

function ir(nodes: { id: string; type?: string }[], edges: [string, string, string?][]): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf', name: 'wf' },
    entrypoints: [nodes[0]!.id],
    nodes: nodes.map((n, i) => ({
      id: n.id,
      kind: i === 0 ? 'trigger' : 'logic',
      type: n.type ?? (i === 0 ? 'manual.trigger' : 'core.transform'),
      operationVersion: '0.1.0',
      parameters: {},
    })),
    edges: edges.map(([from, to, port], i) => ({
      id: `e${i}`,
      from: { nodeId: from, port: port ?? 'main' },
      to: { nodeId: to, port: 'input' },
    })),
  };
}

const o = (nodeId: string, status: NodeOutcome['status'], outputPort?: string): NodeOutcome =>
  outputPort === undefined ? { nodeId, status } : { nodeId, status, outputPort };

describe('computeReadiness', () => {
  const linear = ir([{ id: 't' }, { id: 'a' }, { id: 'b' }], [['t', 'a'], ['a', 'b']]);

  test('linear chain: downstream becomes ready as upstream succeeds', () => {
    const r = computeReadiness(linear, [o('t', 'SUCCEEDED', 'main'), o('a', 'PENDING'), o('b', 'PENDING')]);
    expect(r.ready).toEqual(['a']);
    expect(r.skipped).toEqual([]);
    expect(r.terminal).toBeNull();
  });

  test('linear chain complete: terminal SUCCEEDED', () => {
    const r = computeReadiness(linear, [
      o('t', 'SUCCEEDED', 'main'),
      o('a', 'SUCCEEDED', 'main'),
      o('b', 'SUCCEEDED', 'main'),
    ]);
    expect(r.ready).toEqual([]);
    expect(r.terminal).toBe('SUCCEEDED');
  });

  test('any FAILED node makes terminal FAILED', () => {
    const r = computeReadiness(linear, [o('t', 'SUCCEEDED', 'main'), o('a', 'FAILED'), o('b', 'PENDING')]);
    expect(r.terminal).toBe('FAILED');
  });

  const branched = ir(
    [{ id: 't' }, { id: 'branch', type: 'core.if' }, { id: 'big' }, { id: 'small' }, { id: 'after' }],
    [
      ['t', 'branch'],
      ['branch', 'big', 'true'],
      ['branch', 'small', 'false'],
      ['big', 'after'],
    ],
  );

  test('IF routing: selected port ready, other subtree skipped transitively', () => {
    const r = computeReadiness(branched, [
      o('t', 'SUCCEEDED', 'main'),
      o('branch', 'SUCCEEDED', 'false'),
      o('big', 'PENDING'),
      o('small', 'PENDING'),
      o('after', 'PENDING'),
    ]);
    expect(r.ready).toEqual(['small']);
    expect(r.skipped.sort()).toEqual(['after', 'big']);
    expect(r.terminal).toBeNull();
  });

  test('IF false path complete: terminal SUCCEEDED counts new skips', () => {
    const r = computeReadiness(branched, [
      o('t', 'SUCCEEDED', 'main'),
      o('branch', 'SUCCEEDED', 'false'),
      o('big', 'PENDING'),
      o('small', 'SUCCEEDED', 'main'),
      o('after', 'PENDING'),
    ]);
    expect(r.ready).toEqual([]);
    expect(r.skipped.sort()).toEqual(['after', 'big']);
    expect(r.terminal).toBe('SUCCEEDED');
  });

  const diamond = ir(
    [{ id: 't' }, { id: 'l' }, { id: 'r' }, { id: 'join' }],
    [
      ['t', 'l'],
      ['t', 'r'],
      ['l', 'join'],
      ['r', 'join'],
    ],
  );

  test('diamond join waits for all active parents', () => {
    const half = computeReadiness(diamond, [
      o('t', 'SUCCEEDED', 'main'),
      o('l', 'SUCCEEDED', 'main'),
      o('r', 'RUNNING'),
      o('join', 'PENDING'),
    ]);
    expect(half.ready).toEqual([]);
    const both = computeReadiness(diamond, [
      o('t', 'SUCCEEDED', 'main'),
      o('l', 'SUCCEEDED', 'main'),
      o('r', 'SUCCEEDED', 'main'),
      o('join', 'PENDING'),
    ]);
    expect(both.ready).toEqual(['join']);
  });

  test('does not re-ready nodes that are already QUEUED/RUNNING/SUCCEEDED', () => {
    const r = computeReadiness(linear, [o('t', 'SUCCEEDED', 'main'), o('a', 'RUNNING'), o('b', 'PENDING')]);
    expect(r.ready).toEqual([]);
  });
});
