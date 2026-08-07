import { describe, expect, test } from 'vitest';
import { fmtDuration, fmtTime, nodeLabel, shortId } from '../src/lib/format';

describe('format helpers', () => {
  test('shortId truncates to 8 chars', () => {
    expect(shortId('3f2a4b6c-1d2e-4f5a-8b9c')).toBe('3f2a4b6c');
  });

  test('fmtDuration scales ms → s → m and guards bad input', () => {
    const t0 = '2026-07-24T00:00:00.000Z';
    expect(fmtDuration(t0, '2026-07-24T00:00:00.250Z')).toBe('250ms');
    expect(fmtDuration(t0, '2026-07-24T00:00:02.500Z')).toBe('2.5s');
    expect(fmtDuration(t0, '2026-07-24T00:01:30.000Z')).toBe('1m 30s');
    expect(fmtDuration(null, t0)).toBe('—');
    expect(fmtDuration(t0, null)).toBe('—');
    expect(fmtDuration('garbage', t0)).toBe('—');
  });

  test('fmtTime handles null and invalid dates', () => {
    expect(fmtTime(null)).toBe('—');
    expect(fmtTime('garbage')).toBe('—');
    expect(fmtTime('2026-07-24T00:00:00.000Z')).not.toBe('—');
  });
});

describe('nodeLabel', () => {
  test('an ordinary node reads as itself', () => {
    expect(nodeLabel('sheets')).toEqual({ text: 'sheets', iteration: null });
  });

  test('a loop instance reads as its authored node and a 1-based iteration', () => {
    // The stored id is zero-based; people count from one.
    expect(nodeLabel('b1#0')).toEqual({ text: 'b1', iteration: 1 });
    expect(nodeLabel('b1#3')).toEqual({ text: 'b1', iteration: 4 });
  });

  test('a synthetic join reads as its loop finishing', () => {
    expect(nodeLabel('lp$join')).toEqual({ text: 'lp — all iterations done', iteration: null });
  });

  test('an id that merely contains a hash is not an instance', () => {
    expect(nodeLabel('b1#x')).toEqual({ text: 'b1#x', iteration: null });
  });
});
