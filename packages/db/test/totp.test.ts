import { describe, expect, test } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotpCode,
  TOTP_STEP_SECONDS,
} from '../src/totp.js';

/** RFC 6238 Appendix B, the SHA-1 rows. The seed is ASCII "12345678901234567890". */
const RFC_SEED = Buffer.from('12345678901234567890', 'utf8');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('base32', () => {
  // RFC 4648 section 10, padding stripped — we never emit '='.
  test.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %o to %o', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'utf8'))).toBe(encoded);
  });

  test('decode is the inverse of encode, padding and case notwithstanding', () => {
    expect(base32Decode('MZXW6YTBOI').toString('utf8')).toBe('foobar');
    expect(base32Decode('mzxw6ytboi').toString('utf8')).toBe('foobar');
    expect(base32Decode('MZXW6YTBOI======').toString('utf8')).toBe('foobar');
  });

  test('rejects a character outside the alphabet', () => {
    // '1' and '8' are excluded by RFC 4648 precisely because they look like 'l' and 'B'.
    expect(() => base32Decode('MZXW1YTB')).toThrow(/base32/);
  });
});

describe('totpCode', () => {
  test.each(RFC_VECTORS)('matches the RFC 6238 vector at t=%i', (seconds, expected) => {
    const counter = Math.floor(seconds / TOTP_STEP_SECONDS);
    expect(totpCode(RFC_SEED, counter, 8)).toBe(expected);
  });

  test('a six-digit code is the last six digits of the eight-digit one', () => {
    const counter = Math.floor(1111111109 / TOTP_STEP_SECONDS);
    expect(totpCode(RFC_SEED, counter)).toBe('081804');
  });
});

describe('verifyTotpCode', () => {
  const at = (seconds: number) => seconds * 1000;

  test('accepts the current step and returns which one matched', () => {
    const step = Math.floor(1111111109 / TOTP_STEP_SECONDS);
    expect(verifyTotpCode({ secret: RFC_SEED, code: '081804', now: at(1111111109) })).toBe(step);
  });

  test('accepts one step either side for clock drift', () => {
    const now = at(1111111109 + TOTP_STEP_SECONDS);
    expect(verifyTotpCode({ secret: RFC_SEED, code: '081804', now })).not.toBeNull();
  });

  test('refuses a code two steps old', () => {
    const now = at(1111111109 + TOTP_STEP_SECONDS * 2);
    expect(verifyTotpCode({ secret: RFC_SEED, code: '081804', now })).toBeNull();
  });

  test('refuses any step at or below `after`', () => {
    // This is the replay floor. Without it a code stays usable for its whole 90-second
    // window, so anyone who saw it once can spend it again.
    const step = Math.floor(1111111109 / TOTP_STEP_SECONDS);
    expect(verifyTotpCode({ secret: RFC_SEED, code: '081804', now: at(1111111109), after: step })).toBeNull();
    expect(verifyTotpCode({ secret: RFC_SEED, code: '081804', now: at(1111111109), after: step - 1 })).toBe(step);
  });

  test('refuses malformed input without throwing', () => {
    const now = at(1111111109);
    for (const code of ['', '81804', '0818040', 'abcdef', '08 18 04']) {
      expect(verifyTotpCode({ secret: RFC_SEED, code, now })).toBeNull();
    }
  });
});

describe('secrets and the enrolment URI', () => {
  test('generates a 160-bit secret whose base32 round-trips', () => {
    const { secret, base32 } = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32)).toEqual(secret);
  });

  test('builds an otpauth URI an authenticator app can read', () => {
    const uri = otpauthUri({ issuer: 'Xperiment', account: 'a@b.co', base32: 'MZXW6YTBOI' });
    expect(uri.startsWith('otpauth://totp/Xperiment%3Aa%40b.co?')).toBe(true);
    expect(uri).toContain('secret=MZXW6YTBOI');
    expect(uri).toContain('issuer=Xperiment');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
