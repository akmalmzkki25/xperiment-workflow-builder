import { randomBytes } from 'node:crypto';
import { openBytes, sealBytes } from '../crypto.js';
import type { WorkspaceKeyring } from './keyring.js';

/** Written before envelope encryption: `iv || tag || ct` under one global key. */
export const ENC_VERSION_LEGACY = 0;
/** Envelope: a per-secret DEK wrapped by the workspace KEK. */
export const ENC_VERSION_ENVELOPE = 1;

const FORMAT_MARKER = 0x01;
const MARKER_LEN = 1;
const LENGTH_LEN = 2;
const DEK_LEN = 32;

export interface EncryptedSecret {
  blob: Buffer;
  encVersion: number;
}

export interface SecretVault {
  encrypt(workspaceId: string, plaintext: string): Promise<EncryptedSecret>;
  decrypt(workspaceId: string, secret: EncryptedSecret): Promise<string>;
}

/**
 * One vault per legacy key family — a v0 blob must be opened with the key it was
 * written under, and there were two (TRIGGER_SECRET_KEY, CREDENTIALS_SECRET_KEY). Both
 * vaults share one keyring so the split does not double KMS traffic. From v1 onward the
 * families merge: every secret in a workspace is under that workspace's KEK.
 *
 * The v1 blob layout is:
 *
 *   [1]    format marker 0x01
 *   [2]    wrapped-DEK length, big-endian uint16
 *   [N]    DEK wrapped by the workspace KEK, with the workspace id as AAD
 *   [rest] payload sealed under the DEK
 */
export function createSecretVault(args: { keyring: WorkspaceKeyring; legacyKey: Buffer }): SecretVault {
  return {
    async encrypt(workspaceId, plaintext) {
      const kek = await args.keyring.keyFor(workspaceId);
      const dek = randomBytes(DEK_LEN);
      // AAD binds the DEK to its workspace: a blob moved into another tenant's row
      // fails to open instead of decrypting.
      const wrappedDek = sealBytes(dek, kek, Buffer.from(workspaceId, 'utf8'));
      const header = Buffer.alloc(MARKER_LEN + LENGTH_LEN);
      header[0] = FORMAT_MARKER;
      header.writeUInt16BE(wrappedDek.length, MARKER_LEN);
      const payload = sealBytes(Buffer.from(plaintext, 'utf8'), dek);
      return {
        blob: Buffer.concat([header, wrappedDek, payload]),
        encVersion: ENC_VERSION_ENVELOPE,
      };
    },

    async decrypt(workspaceId, secret) {
      if (secret.encVersion === ENC_VERSION_LEGACY) {
        return openBytes(secret.blob, args.legacyKey).toString('utf8');
      }
      if (secret.encVersion !== ENC_VERSION_ENVELOPE) {
        throw new Error(`Unsupported enc_version ${secret.encVersion}`);
      }
      // The version column is the authority for dispatch; the marker is a consistency
      // assertion, so a blob and version that drifted apart fail loudly instead of
      // reading a random IV byte as a length.
      if (secret.blob.length < MARKER_LEN + LENGTH_LEN || secret.blob[0] !== FORMAT_MARKER) {
        throw new Error('Unrecognised envelope secret format');
      }
      const wrappedLen = secret.blob.readUInt16BE(MARKER_LEN);
      const dekEnd = MARKER_LEN + LENGTH_LEN + wrappedLen;
      if (secret.blob.length <= dekEnd) throw new Error('Truncated envelope secret');
      const wrappedDek = secret.blob.subarray(MARKER_LEN + LENGTH_LEN, dekEnd);
      const kek = await args.keyring.keyFor(workspaceId);
      const dek = openBytes(wrappedDek, kek, Buffer.from(workspaceId, 'utf8'));
      return openBytes(secret.blob.subarray(dekEnd), dek).toString('utf8');
    },
  };
}
