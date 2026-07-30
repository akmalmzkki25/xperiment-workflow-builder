import { randomBytes } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  createKeyProviderFromEnv,
  gcpKmsKeyProvider,
  localKeyProvider,
  type KmsClientLike,
} from '../src/crypto/keyProvider.js';

/** Reversible stand-in for KMS: prefixes the plaintext so wrap/unwrap are observable. */
function fakeKmsClient(): KmsClientLike & { encryptCalls: string[]; decryptCalls: string[] } {
  const encryptCalls: string[] = [];
  const decryptCalls: string[] = [];
  return {
    encryptCalls,
    decryptCalls,
    async encrypt(req) {
      encryptCalls.push(req.name);
      return [{ ciphertext: Buffer.concat([Buffer.from('kms:'), req.plaintext]) }];
    },
    async decrypt(req) {
      decryptCalls.push(req.name);
      return [{ plaintext: req.ciphertext.subarray('kms:'.length) }];
    },
  };
}

const KEY_NAME = 'projects/p/locations/l/keyRings/r/cryptoKeys/k';

describe('localKeyProvider', () => {
  test('round-trips a 32-byte key', async () => {
    const p = localKeyProvider('master-secret');
    const dek = randomBytes(32);
    expect((await p.unwrap(await p.wrap(dek))).equals(dek)).toBe(true);
    expect(p.name).toBe('local');
  });

  test('two instances built from the same secret are interchangeable', async () => {
    const a = localKeyProvider('same');
    const b = localKeyProvider('same');
    const dek = randomBytes(32);
    expect((await b.unwrap(await a.wrap(dek))).equals(dek)).toBe(true);
    expect(a.keyId).toBe(b.keyId);
  });

  test('a different master secret cannot unwrap, and has a different keyId', async () => {
    const a = localKeyProvider('one');
    const b = localKeyProvider('two');
    expect(a.keyId).not.toBe(b.keyId);
    await expect(b.unwrap(await a.wrap(randomBytes(32)))).rejects.toThrow();
  });

  test('keyId is not a bare hash of the master secret', () => {
    // Domain-separated, so the stored id cannot be checked against a naive
    // sha256(secret) guess taken from a leaked database dump.
    const p = localKeyProvider('master-secret');
    expect(p.keyId.startsWith('local:')).toBe(true);
    expect(p.keyId).not.toContain('master-secret');
  });

  test('two wraps of the same key differ but both unwrap', async () => {
    const p = localKeyProvider('m');
    const dek = randomBytes(32);
    const w1 = await p.wrap(dek);
    const w2 = await p.wrap(dek);
    expect(w1.equals(w2)).toBe(false);
    expect((await p.unwrap(w1)).equals(dek)).toBe(true);
    expect((await p.unwrap(w2)).equals(dek)).toBe(true);
  });
});

describe('gcpKmsKeyProvider', () => {
  test('wraps and unwraps through the client using the configured key name', async () => {
    const client = fakeKmsClient();
    const p = gcpKmsKeyProvider({ keyName: KEY_NAME, client });
    const dek = randomBytes(32);
    const wrapped = await p.wrap(dek);
    expect((await p.unwrap(wrapped)).equals(dek)).toBe(true);
    expect(client.encryptCalls).toEqual([KEY_NAME]);
    expect(client.decryptCalls).toEqual([KEY_NAME]);
    expect(p.name).toBe('gcp-kms');
    expect(p.keyId).toBe(KEY_NAME);
  });

  test('converts a Uint8Array response into a Buffer', async () => {
    const client: KmsClientLike = {
      async encrypt() {
        return [{ ciphertext: new Uint8Array([1, 2, 3]) }];
      },
      async decrypt() {
        return [{ plaintext: new Uint8Array([4, 5, 6]) }];
      },
    };
    const p = gcpKmsKeyProvider({ keyName: KEY_NAME, client });
    const wrapped = await p.wrap(randomBytes(32));
    expect(Buffer.isBuffer(wrapped)).toBe(true);
    expect([...wrapped]).toEqual([1, 2, 3]);
    const un = await p.unwrap(Buffer.alloc(3));
    expect(Buffer.isBuffer(un)).toBe(true);
    expect([...un]).toEqual([4, 5, 6]);
  });

  test('a base64 string response is decoded, matching the REST transport', async () => {
    const client: KmsClientLike = {
      async encrypt() {
        return [{ ciphertext: Buffer.from([9, 9]).toString('base64') }];
      },
      async decrypt() {
        return [{ plaintext: Buffer.from([8]).toString('base64') }];
      },
    };
    const p = gcpKmsKeyProvider({ keyName: KEY_NAME, client });
    expect([...(await p.wrap(randomBytes(32)))]).toEqual([9, 9]);
    expect([...(await p.unwrap(Buffer.alloc(1)))]).toEqual([8]);
  });

  test('an empty response throws instead of yielding an empty Buffer', async () => {
    const client: KmsClientLike = {
      async encrypt() {
        return [{}];
      },
      async decrypt() {
        return [{ plaintext: null }];
      },
    };
    const p = gcpKmsKeyProvider({ keyName: KEY_NAME, client });
    await expect(p.wrap(randomBytes(32))).rejects.toThrow(/no ciphertext/i);
    await expect(p.unwrap(Buffer.alloc(1))).rejects.toThrow(/no plaintext/i);
  });
});

describe('createKeyProviderFromEnv', () => {
  test('defaults to the local provider', async () => {
    const p = await createKeyProviderFromEnv({});
    expect(p.name).toBe('local');
  });

  test('gcp-kms builds the client lazily from the factory', async () => {
    const factory = vi.fn(async () => fakeKmsClient() as KmsClientLike);
    const p = await createKeyProviderFromEnv({ KMS_PROVIDER: 'gcp-kms', KMS_KEY_NAME: KEY_NAME }, factory);
    expect(p.name).toBe('gcp-kms');
    expect(p.keyId).toBe(KEY_NAME);
    expect(factory).toHaveBeenCalledWith(KEY_NAME);
  });

  test('gcp-kms without a key name fails at startup, not at first use', async () => {
    await expect(createKeyProviderFromEnv({ KMS_PROVIDER: 'gcp-kms' })).rejects.toThrow(/KMS_KEY_NAME/);
  });

  test('an unknown provider name is rejected rather than silently falling back to local', async () => {
    await expect(createKeyProviderFromEnv({ KMS_PROVIDER: 'azure' })).rejects.toThrow(/KMS_PROVIDER/);
  });
});
