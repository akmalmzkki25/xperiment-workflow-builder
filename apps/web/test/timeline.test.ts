import { describe, expect, test } from 'vitest';
import type { ExecutionNodeRow } from '../src/lib/api';
import { attemptError, attemptPortLabel, groupAttemptsByNode } from '../src/lib/timeline';
import { waitDecisionLine, waitKindLabel } from '../src/lib/waitLabel';

const row = (nodeId: string, attempt: number): ExecutionNodeRow => ({
  nodeId,
  attempt,
  status: 'SUCCEEDED',
  outputPort: 'main',
  errorJson: null,
  startedAt: null,
  completedAt: null,
});

describe('groupAttemptsByNode', () => {
  test('groups attempts under their node in first-seen order', () => {
    const grouped = groupAttemptsByNode([row('a', 1), row('b', 1), row('a', 2)]);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')!.map((r) => r.attempt)).toEqual([1, 2]);
    expect(grouped.get('b')).toHaveLength(1);
  });

  test('an empty list produces an empty map', () => {
    expect(groupAttemptsByNode([]).size).toBe(0);
  });
});

describe('attemptError', () => {
  test('joins a code and a message', () => {
    expect(attemptError({ code: 'http_error', message: 'boom' })).toBe('http_error: boom');
  });

  test('renders whichever of the two is present', () => {
    expect(attemptError({ code: 'timeout' })).toBe('timeout');
    expect(attemptError({ message: 'boom' })).toBe('boom');
  });

  test('is null when there is nothing to say', () => {
    expect(attemptError(null)).toBeNull();
    expect(attemptError(undefined)).toBeNull();
    expect(attemptError('a string')).toBeNull();
    expect(attemptError({})).toBeNull();
    expect(attemptError({ details: { body: 'ignored' } })).toBeNull();
  });

  test('ignores non-string code and message rather than printing [object Object]', () => {
    expect(attemptError({ code: 42, message: { nested: true } })).toBeNull();
    expect(attemptError({ code: '', message: '' })).toBeNull();
  });

  test('never surfaces details, which can carry a provider response body', () => {
    const out = attemptError({ code: 'http_error', message: 'failed', details: { body: 'secret-body' } });
    expect(out).toBe('http_error: failed');
    expect(out).not.toContain('secret-body');
  });
});

describe('attemptPortLabel', () => {
  test('says nothing for the default path', () => {
    expect(attemptPortLabel('main')).toBeNull();
    expect(attemptPortLabel(null)).toBeNull();
    expect(attemptPortLabel('')).toBeNull();
  });

  test('names any other port', () => {
    expect(attemptPortLabel('error')).toBe('error');
    expect(attemptPortLabel('case3')).toBe('case3');
    expect(attemptPortLabel('empty')).toBe('empty');
  });
});

describe('wait labels', () => {
  test('names the three known kinds', () => {
    expect(waitKindLabel('timer')).toBe('Waiting on a timer');
    expect(waitKindLabel('event')).toBe('Waiting for an event');
    expect(waitKindLabel('approval')).toBe('Waiting for an approval');
  });

  test('falls back to the raw kind rather than to blank', () => {
    // "Waiting, reason unknown" beats an empty line for an operator.
    expect(waitKindLabel('something_new')).toBe('something_new');
  });

  test('the decision line is null until there is a decision', () => {
    expect(waitDecisionLine(null, null)).toBeNull();
    expect(waitDecisionLine(null, 'user-1')).toBeNull();
    expect(waitDecisionLine('approved', null)).toBe('Decided approved');
    expect(waitDecisionLine('rejected', 'budi@xperiment.test')).toBe('Decided rejected by budi@xperiment.test');
  });
});
