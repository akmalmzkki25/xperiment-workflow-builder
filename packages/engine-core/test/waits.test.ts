import { describe, expect, test } from 'vitest';
import { approvalFallbackOutcome, canTransitionNode, computeReadiness, type NodeOutcome } from '../src/index.js';
import type { WorkflowIR } from '@xperiment/ir';

describe('WAITING transitions', () => {
  test('a running node may suspend into WAITING', () => {
    expect(canTransitionNode('RUNNING', 'WAITING')).toBe(true);
  });

  test('a waiting node resumes to a terminal, never back to a queue', () => {
    expect(canTransitionNode('WAITING', 'SUCCEEDED')).toBe(true);
    expect(canTransitionNode('WAITING', 'FAILED')).toBe(true);
    expect(canTransitionNode('WAITING', 'SKIPPED')).toBe(true);
    expect(canTransitionNode('WAITING', 'QUEUED')).toBe(false);
    expect(canTransitionNode('WAITING', 'RUNNING')).toBe(false);
  });
});

describe('approvalFallbackOutcome', () => {
  test('maps each fallback to a resume outcome', () => {
    expect(approvalFallbackOutcome('approve')).toEqual({ terminal: 'SUCCEEDED', outputPort: 'approved' });
    expect(approvalFallbackOutcome('reject')).toEqual({ terminal: 'SUCCEEDED', outputPort: 'rejected' });
    expect(approvalFallbackOutcome('fail')).toEqual({ terminal: 'FAILED' });
  });
});

function ir(nodes: { id: string }[], edges: [string, string, string?][]): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf', name: 'wf' },
    entrypoints: [nodes[0]!.id],
    nodes: nodes.map((n, i) => ({
      id: n.id,
      kind: i === 0 ? 'trigger' : 'logic',
      type: i === 0 ? 'manual.trigger' : 'core.transform',
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

describe('computeReadiness with a WAITING node', () => {
  test('a waiting node pauses the branch: nothing ready, not terminal', () => {
    const wf = ir([{ id: 't' }, { id: 'wait' }, { id: 'after' }], [['t', 'wait'], ['wait', 'after']]);
    const outcomes: NodeOutcome[] = [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'wait', status: 'WAITING' },
    ];
    const r = computeReadiness(wf, outcomes);
    expect(r.ready).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.terminal).toBeNull();
  });
});
