import { describe, expect, test } from 'vitest';
import { RUN_STATUS_RANK, runStatusByNode } from '../src/lib/runStatus';

describe('runStatusByNode', () => {
  test('keeps the latest attempt for a node', () => {
    const map = runStatusByNode([
      { nodeId: 'a', status: 'FAILED', attempt: 1 },
      { nodeId: 'a', status: 'SUCCEEDED', attempt: 2 },
    ]);
    expect(map.get('a')).toBe('SUCCEEDED');
  });

  test('folds loop instances onto the id the author wrote', () => {
    // The canvas has one node `b1`; the execution reports b1#0, b1#1, b1#2.
    const map = runStatusByNode([
      { nodeId: 'b1#0', status: 'SUCCEEDED', attempt: 1 },
      { nodeId: 'b1#1', status: 'SUCCEEDED', attempt: 1 },
      { nodeId: 'lp$join', status: 'SUCCEEDED', attempt: 1 },
    ]);
    expect(map.get('b1')).toBe('SUCCEEDED');
    expect(map.get('lp')).toBe('SUCCEEDED');
    expect(map.has('b1#0')).toBe(false);
  });

  test('a single failed iteration colours the whole body failed', () => {
    const map = runStatusByNode([
      { nodeId: 'b1#0', status: 'SUCCEEDED', attempt: 1 },
      { nodeId: 'b1#1', status: 'FAILED', attempt: 1 },
      { nodeId: 'b1#2', status: 'SUCCEEDED', attempt: 1 },
    ]);
    expect(map.get('b1')).toBe('FAILED');
  });

  test('a running iteration outranks succeeded siblings', () => {
    const map = runStatusByNode([
      { nodeId: 'b1#0', status: 'SUCCEEDED', attempt: 1 },
      { nodeId: 'b1#1', status: 'RUNNING', attempt: 1 },
    ]);
    expect(map.get('b1')).toBe('RUNNING');
  });

  test('a failure outranks a running sibling', () => {
    const map = runStatusByNode([
      { nodeId: 'b1#0', status: 'RUNNING', attempt: 1 },
      { nodeId: 'b1#1', status: 'FAILED', attempt: 1 },
    ]);
    expect(map.get('b1')).toBe('FAILED');
  });

  test('an unknown status sorts last and never masks a failure', () => {
    // A future engine state must not be able to hide a red node.
    const map = runStatusByNode([
      { nodeId: 'b1#0', status: 'FAILED', attempt: 1 },
      { nodeId: 'b1#1', status: 'SOMETHING_NEW', attempt: 1 },
    ]);
    expect(map.get('b1')).toBe('FAILED');
    const alone = runStatusByNode([{ nodeId: 'x', status: 'SOMETHING_NEW', attempt: 1 }]);
    expect(alone.get('x')).toBe('SOMETHING_NEW');
  });

  test('the latest attempt wins before the iterations are folded', () => {
    // b1#0 retried and succeeded; b1#1 only ever failed. The body is still failed, but
    // for the right reason — not because attempt 1 of b1#0 was left in the fold.
    const map = runStatusByNode([
      { nodeId: 'b1#0', status: 'FAILED', attempt: 1 },
      { nodeId: 'b1#0', status: 'SUCCEEDED', attempt: 2 },
      { nodeId: 'b1#1', status: 'RETRY_SCHEDULED', attempt: 1 },
    ]);
    expect(map.get('b1')).toBe('RETRY_SCHEDULED');
  });

  test('an empty list produces an empty map', () => {
    expect(runStatusByNode([]).size).toBe(0);
  });

  test('the rank has no duplicates and covers every engine state', () => {
    expect(new Set(RUN_STATUS_RANK).size).toBe(RUN_STATUS_RANK.length);
    for (const status of ['PENDING', 'READY', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED']) {
      expect(RUN_STATUS_RANK, status).toContain(status);
    }
  });
});
