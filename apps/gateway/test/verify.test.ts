import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { extractDedupKey, sanitizeHeaders, verifyHmac, verifyToken } from '../src/verify.js';

describe('verifyToken', () => {
  test('accepts exact bearer match only', () => {
    expect(verifyToken('Bearer sek', 'sek')).toBe(true);
    expect(verifyToken('Bearer nope', 'sek')).toBe(false);
    expect(verifyToken('sek', 'sek')).toBe(false); // missing scheme
    expect(verifyToken(undefined, 'sek')).toBe(false);
    expect(verifyToken('Bearer', 'sek')).toBe(false);
  });
});

describe('verifyHmac', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + createHmac('sha256', 'sek').update(body).digest('hex');

  test('accepts a correct signature over the raw body', () => {
    expect(verifyHmac(sig, 'sek', body)).toBe(true);
  });
  test('rejects wrong secret, altered body, bad format, missing header', () => {
    expect(verifyHmac(sig, 'other', body)).toBe(false);
    expect(verifyHmac(sig, 'sek', Buffer.from('{"a":2}'))).toBe(false);
    expect(verifyHmac('md5=abc', 'sek', body)).toBe(false);
    expect(verifyHmac('sha256=zz', 'sek', body)).toBe(false);
    expect(verifyHmac(undefined, 'sek', body)).toBe(false);
  });
});

describe('extractDedupKey', () => {
  test('resolves dot paths to strings and numbers', () => {
    expect(extractDedupKey({ event: { id: 'e-1' } }, 'event.id')).toBe('e-1');
    expect(extractDedupKey({ n: 7 }, 'n')).toBe('7');
    expect(extractDedupKey({ a: { b: null } }, 'a.b')).toBeNull();
    expect(extractDedupKey({ a: 1 }, 'missing.path')).toBeNull();
    expect(extractDedupKey({ obj: {} }, 'obj')).toBeNull(); // non-scalar
    expect(extractDedupKey({ a: 1 }, null)).toBeNull();
  });
});

describe('sanitizeHeaders', () => {
  test('drops sensitive headers, keeps the rest as strings', () => {
    const out = sanitizeHeaders({
      Authorization: 'Bearer x',
      Cookie: 'sid=1',
      'X-Xperiment-Signature': 'sha256=..',
      'Content-Type': 'application/json',
      'x-custom': 'keep',
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'x-custom': 'keep' });
  });
});
