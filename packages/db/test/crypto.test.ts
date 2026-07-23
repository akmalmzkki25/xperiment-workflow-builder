import { describe, expect, test } from 'vitest';
import { decryptSecret, deriveTriggerKey, encryptSecret } from '../src/crypto.js';

describe('trigger secret crypto', () => {
  const key = deriveTriggerKey('xperiment-dev-trigger-secret-change-me');

  test('derives a 32-byte key from any string', () => {
    expect(key.length).toBe(32);
    expect(deriveTriggerKey('other').equals(key)).toBe(false);
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
    expect(() => decryptSecret(buf, deriveTriggerKey('wrong'))).toThrow();
  });
});
