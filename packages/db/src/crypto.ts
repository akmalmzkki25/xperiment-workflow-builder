import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Bare SHA-256 of an env string — not a KDF. Retained only to read blobs written
 * before envelope encryption (`enc_version = 0`). Once `rekeyAll` reports zero
 * remaining rows on every encrypted column, this and the two env vars that feed it
 * (TRIGGER_SECRET_KEY, CREDENTIALS_SECRET_KEY) can be removed.
 */
export function deriveLegacyKey(envValue: string): Buffer {
  return createHash('sha256').update(envValue).digest();
}

/**
 * AES-256-GCM over raw bytes, emitting `iv || tag || ciphertext`. This layout is the
 * on-disk format of every legacy secret, so it must not change.
 *
 * `aad` binds the ciphertext to a context (the vault passes the workspace id), so a
 * blob copied into another tenant's row fails to open instead of decrypting.
 */
export function sealBytes(plaintext: Buffer, key: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function openBytes(buf: Buffer, key: Buffer, aad?: Buffer): Buffer {
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  return sealBytes(Buffer.from(plaintext, 'utf8'), key);
}

export function decryptSecret(buf: Buffer, key: Buffer): string {
  return openBytes(buf, key).toString('utf8');
}
