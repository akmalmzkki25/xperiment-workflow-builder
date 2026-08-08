import { describe, expect, test } from 'vitest';
import { authoredNodeId, fmtDuration, fmtJakarta, fmtTime, nodeLabel, shortId } from '../src/lib/format';

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

describe('fmtJakarta', () => {
  test('renders absolute Jakarta wall time with the zone named', () => {
    // 22:30 UTC is already 05:30 the next day in Jakarta — a relative label computed off
    // the viewer's own clock would read this wrong for anyone outside WIB.
    expect(fmtJakarta('2026-03-01T22:30:00.000Z')).toBe('02/03/2026 05:30 WIB');
  });

  test('midnight renders as 00, not 24', () => {
    expect(fmtJakarta('2026-03-01T17:00:00.000Z')).toBe('02/03/2026 00:00 WIB');
  });

  test('returns a dash for null and for an unparseable value', () => {
    expect(fmtJakarta(null)).toBe('—');
    expect(fmtJakarta('not a date')).toBe('—');
  });
});

describe('authoredNodeId', () => {
  test('strips a loop iteration suffix and a synthetic join suffix', () => {
    expect(authoredNodeId('b1#3')).toBe('b1');
    expect(authoredNodeId('lp$join')).toBe('lp');
  });

  test('leaves an ordinary id and a non-numeric hash alone', () => {
    // A '#' is not legal in an authored id, but the guard must not eat one either way.
    expect(authoredNodeId('send_receipt')).toBe('send_receipt');
    expect(authoredNodeId('a#b')).toBe('a#b');
    expect(authoredNodeId('#3')).toBe('#3');
  });

  test('agrees with nodeLabel about where the engine suffix begins', () => {
    for (const id of ['b1#0', 'b1#12', 'lp$join', 'plain']) {
      expect(nodeLabel(id).text, id).toBe(
        id.endsWith('$join') ? `${authoredNodeId(id)} — all iterations done` : authoredNodeId(id),
      );
    }
  });
});
