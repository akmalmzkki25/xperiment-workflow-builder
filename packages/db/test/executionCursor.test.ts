import { describe, expect, test } from 'vitest';
import {
  decodeExecutionCursor,
  encodeExecutionCursor,
  filterFingerprint,
} from '../src/repos/executionCursor.js';

const AT = new Date('2026-08-11T09:00:00.000Z');
const ID = '11111111-1111-1111-1111-111111111111';

describe('filterFingerprint', () => {
  test('is stable regardless of the order statuses were listed in', () => {
    expect(filterFingerprint({ status: ['FAILED', 'TIMED_OUT'] })).toBe(
      filterFingerprint({ status: ['TIMED_OUT', 'FAILED'] }),
    );
  });

  test('no filter and an empty filter are the same thing', () => {
    expect(filterFingerprint({})).toBe(filterFingerprint({ status: [], workflowId: undefined }));
  });

  test('distinguishes the filters that would return different rows', () => {
    const none = filterFingerprint({});
    expect(filterFingerprint({ status: ['FAILED'] })).not.toBe(none);
    expect(filterFingerprint({ workflowId: 'wf-1' })).not.toBe(none);
    expect(filterFingerprint({ status: ['FAILED'] })).not.toBe(filterFingerprint({ status: ['SUCCEEDED'] }));
  });
});

describe('cursor round trip', () => {
  test('decodes back to the position it encoded', () => {
    const cursor = encodeExecutionCursor(AT, ID, { status: ['FAILED'] });
    const out = decodeExecutionCursor(cursor, { status: ['FAILED'] });
    expect(out).toEqual({ ok: true, createdAt: AT.toISOString(), id: ID });
  });

  test('a cursor from a DIFFERENT filter is refused, not silently followed', () => {
    // This is the whole reason the fingerprint exists. A keyset cursor is only a
    // position: run it against a different predicate and the query happily returns the
    // page of rows after that position from the WRONG set. No error, no empty result.
    const cursor = encodeExecutionCursor(AT, ID, { status: ['FAILED'] });
    expect(decodeExecutionCursor(cursor, {})).toEqual({ ok: false, reason: 'filter_changed' });
    expect(decodeExecutionCursor(cursor, { status: ['SUCCEEDED'] })).toEqual({
      ok: false,
      reason: 'filter_changed',
    });
    expect(decodeExecutionCursor(cursor, { status: ['FAILED'], workflowId: 'wf-1' })).toEqual({
      ok: false,
      reason: 'filter_changed',
    });
  });

  test('the same filter written differently still matches', () => {
    const cursor = encodeExecutionCursor(AT, ID, { status: ['FAILED', 'TIMED_OUT'] });
    expect(decodeExecutionCursor(cursor, { status: ['TIMED_OUT', 'FAILED'] }).ok).toBe(true);
  });
});

describe('malformed cursors', () => {
  const cases: [string, string][] = [
    ['not base64 at all', '!!!!'],
    ['too few parts', Buffer.from(`${AT.toISOString()}|${ID}`).toString('base64')],
    ['too many parts', Buffer.from(`a|b|c|d`).toString('base64')],
    ['empty timestamp', Buffer.from(`|${ID}|${filterFingerprint({})}`).toString('base64')],
    ['empty id', Buffer.from(`${AT.toISOString()}||${filterFingerprint({})}`).toString('base64')],
    ['unparseable timestamp', Buffer.from(`yesterday|${ID}|${filterFingerprint({})}`).toString('base64')],
    ['empty string', ''],
  ];

  for (const [name, cursor] of cases) {
    test(`${name} is rejected rather than salvaged`, () => {
      // Silently ignoring a bad cursor would show page one while the caller believes
      // they are on page four.
      expect(decodeExecutionCursor(cursor, {}).ok, name).toBe(false);
    });
  }

  test('a two-part cursor from before this change is malformed, not accepted', () => {
    // Cursors live for one page of results, so refusing an old one is a refresh, not
    // data loss — and accepting it would reintroduce exactly the bug being fixed.
    const legacy = Buffer.from(`${AT.toISOString()}|${ID}`).toString('base64');
    expect(decodeExecutionCursor(legacy, {})).toEqual({ ok: false, reason: 'malformed' });
  });
});
