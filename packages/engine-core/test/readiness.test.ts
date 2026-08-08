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

describe('error path', () => {
  // t → a → b, plus a → h on the error port
  const routed = ir(
    [{ id: 't' }, { id: 'a' }, { id: 'b' }, { id: 'h' }],
    [
      ['t', 'a'],
      ['a', 'b'],
      ['a', 'h', 'error'],
    ],
  );
  const plain = ir([{ id: 't' }, { id: 'a' }, { id: 'b' }], [['t', 'a'], ['a', 'b']]);

  test('a failure with an error edge routes there and the run survives', () => {
    const r = computeReadiness(routed, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual(['h']);
    expect(r.skipped).toEqual(['b']);
    expect(r.terminal).toBeNull();
  });

  test('a failure with no error edge still ends the run', () => {
    // Nothing changed for the default policy — every existing workflow keeps its meaning.
    const r = computeReadiness(plain, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual([]);
    expect(r.terminal).toBe('FAILED');
  });

  test("policy 'continue' on the node carries on down main", () => {
    const withPolicy: WorkflowIR = {
      ...plain,
      nodes: plain.nodes.map((n) => (n.id === 'a' ? { ...n, settings: { onError: 'continue' as const } } : n)),
    };
    const r = computeReadiness(withPolicy, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual(['b']);
    expect(r.terminal).toBeNull();
  });

  test('the workflow-wide default applies when the node says nothing', () => {
    const withDefault: WorkflowIR = { ...plain, metadata: { onError: 'continue' } };
    expect(computeReadiness(withDefault, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]).ready).toEqual(['b']);
  });

  test('the node setting beats the workflow default', () => {
    const mixed: WorkflowIR = {
      ...plain,
      metadata: { onError: 'continue' },
      nodes: plain.nodes.map((n) => (n.id === 'a' ? { ...n, settings: { onError: 'fail' as const } } : n)),
    };
    expect(computeReadiness(mixed, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]).terminal).toBe('FAILED');
  });

  test('an error edge wins over a fail policy', () => {
    // The edge is the author's explicit instruction; the policy is only the fallback.
    const explicit: WorkflowIR = {
      ...routed,
      nodes: routed.nodes.map((n) => (n.id === 'a' ? { ...n, settings: { onError: 'fail' as const } } : n)),
    };
    const r = computeReadiness(explicit, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual(['h']);
    expect(r.terminal).toBeNull();
  });

  test('the run completes once the error branch finishes', () => {
    const r = computeReadiness(routed, [o('t', 'SUCCEEDED'), o('a', 'FAILED'), o('h', 'SUCCEEDED')]);
    expect(r.terminal).toBe('SUCCEEDED');
  });

  test('a downstream node still waits for an undecided sibling', () => {
    const fan = ir(
      [{ id: 't' }, { id: 'a' }, { id: 'c' }, { id: 'j' }],
      [
        ['t', 'a'],
        ['t', 'c'],
        ['a', 'j'],
        ['c', 'j'],
      ],
    );
    const withPolicy: WorkflowIR = { ...fan, metadata: { onError: 'continue' } };
    const r = computeReadiness(withPolicy, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    // `a` was handled, but `j` must still wait for `c`, which has not run.
    expect(r.ready).toEqual(['c']);
    expect(r.terminal).toBeNull();
  });

  test('an edge from an unfired switch port is skipped, not left hanging', () => {
    // core.switch declares ten fixed ports, so a graph can legitimately carry an edge from
    // a port that a given run never selects. validateGraph cannot catch an edge from case7
    // when only three cases are configured, because layer 2 never reads node parameters —
    // so the guarantee has to hold at runtime, and it must be SKIPPED rather than ready: [].
    const routed = ir(
      [{ id: 't' }, { id: 'sw', type: 'core.switch' }, { id: 'hit' }, { id: 'miss' }],
      [
        ['t', 'sw'],
        ['sw', 'hit', 'case1'],
        ['sw', 'miss', 'case7'],
      ],
    );
    const r = computeReadiness(routed, [o('t', 'SUCCEEDED'), o('sw', 'SUCCEEDED', 'case1')]);
    expect(r.ready).toEqual(['hit']);
    expect(r.skipped).toEqual(['miss']);
    expect(r.terminal).toBeNull();
  });

  // These two protect core.merge, which relies on the join behaviour below rather than
  // on any scheduler change. If someone later "tightens" readiness to require every
  // inbound edge to be ACTIVE, merge stops working silently and every workflow using it
  // hangs with ready: [] and terminal: null. These are what catches that.
  test('a fan-in behind an if fires once the skipped branch is decided', () => {
    const diamond = ir(
      [{ id: 't' }, { id: 'gate', type: 'core.if' }, { id: 'yes' }, { id: 'no' }, { id: 'mg', type: 'core.merge' }],
      [
        ['t', 'gate'],
        ['gate', 'yes', 'true'],
        ['gate', 'no', 'false'],
        ['yes', 'mg'],
        ['no', 'mg'],
      ],
    );
    const afterGate = computeReadiness(diamond, [o('t', 'SUCCEEDED'), o('gate', 'SUCCEEDED', 'true')]);
    expect(afterGate.ready).toEqual(['yes']);
    expect(afterGate.skipped).toEqual(['no']);

    const afterBranch = computeReadiness(diamond, [
      o('t', 'SUCCEEDED'),
      o('gate', 'SUCCEEDED', 'true'),
      o('yes', 'SUCCEEDED', 'main'),
      o('no', 'SKIPPED'),
    ]);
    // One inbound edge is active and the other is decided-but-inactive, so the merge runs.
    expect(afterBranch.ready).toEqual(['mg']);
    expect(afterBranch.terminal).toBeNull();
  });

  test('a fan-in whose branches are both skipped is itself skipped', () => {
    const diamond = ir(
      [{ id: 't' }, { id: 'gate', type: 'core.if' }, { id: 'yes' }, { id: 'no' }, { id: 'mg', type: 'core.merge' }],
      [
        ['t', 'gate'],
        ['gate', 'yes', 'true'],
        ['gate', 'no', 'false'],
        ['yes', 'mg'],
        ['no', 'mg'],
      ],
    );
    // A switch-style port that fires nothing downstream: both branches decided inactive.
    const r = computeReadiness(diamond, [o('t', 'SUCCEEDED'), o('gate', 'SUCCEEDED', 'other')]);
    expect(r.ready).toEqual([]);
    expect(r.skipped.sort()).toEqual(['mg', 'no', 'yes']);
    expect(r.terminal).toBe('SUCCEEDED');
  });

  test('a switch that reaches default skips every case branch', () => {
    const routed = ir(
      [{ id: 't' }, { id: 'sw', type: 'core.switch' }, { id: 'a' }, { id: 'b' }, { id: 'fallback' }],
      [
        ['t', 'sw'],
        ['sw', 'a', 'case1'],
        ['sw', 'b', 'case2'],
        ['sw', 'fallback', 'default'],
      ],
    );
    const r = computeReadiness(routed, [o('t', 'SUCCEEDED'), o('sw', 'SUCCEEDED', 'default')]);
    expect(r.ready).toEqual(['fallback']);
    expect(r.skipped.sort()).toEqual(['a', 'b']);
  });
});
