import { describe, expect, test } from 'vitest';
import { decryptSecret, deriveLegacyKey, encryptSecret, openBytes, sealBytes } from '../src/crypto.js';

describe('legacy key derivation', () => {
  const key = deriveLegacyKey('xperiment-dev-trigger-secret-change-me');

  test('derives a 32-byte key from any string', () => {
    expect(key.length).toBe(32);
    expect(deriveLegacyKey('other').equals(key)).toBe(false);
  });

  test('round-trips a secret with unique ciphertexts', () => {
    const a = encryptSecret('s3cret-value', key);
    const b = encryptSecret('s3cret-value', key);
    expect(decryptSecret(a, key)).toBe('s3cret-value');
    expect(decryptSecret(b, key)).toBe('s3cret-value');
    expect(a.equals(b)).toBe(false); // random IV
  });

  test('rejects tampered ciphertext and wrong key', () => {
    const buf = encryptSecret('x', key);
    const tampered = Buffer.from(buf);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(buf, deriveLegacyKey('wrong'))).toThrow();
  });
});

describe('sealBytes / openBytes', () => {
  const key = deriveLegacyKey('k');

  test('round-trips arbitrary bytes including a zero byte', () => {
    const plain = Buffer.from([0x00, 0xff, 0x10, 0x00]);
    expect(openBytes(sealBytes(plain, key), key).equals(plain)).toBe(true);
  });

  test('the v0 wire format is unchanged: iv(12) || tag(16) || ciphertext', () => {
    const plain = Buffer.from('abcd', 'utf8');
    const sealed = sealBytes(plain, key);
    expect(sealed.length).toBe(12 + 16 + plain.length);
    // decryptSecret must still read a blob produced by sealBytes, and vice versa,
    // because every existing enc_version = 0 row was written by this exact layout.
    expect(decryptSecret(sealed, key)).toBe('abcd');
    expect(openBytes(encryptSecret('abcd', key), key).toString('utf8')).toBe('abcd');
  });

  test('AAD is authenticated: opening with a different AAD throws', () => {
    const sealed = sealBytes(Buffer.from('x'), key, Buffer.from('ws-a'));
    expect(openBytes(sealed, key, Buffer.from('ws-a')).toString('utf8')).toBe('x');
    expect(() => openBytes(sealed, key, Buffer.from('ws-b'))).toThrow();
    expect(() => openBytes(sealed, key)).toThrow();
  });

  test('a blob sealed without AAD cannot be opened with one', () => {
    const sealed = sealBytes(Buffer.from('x'), key);
    expect(() => openBytes(sealed, key, Buffer.from('ws-a'))).toThrow();
  });
});
