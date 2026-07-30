import { createHash, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { openBytes, sealBytes } from '../crypto.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * Fixed salt, deliberately not configuration. The input is a high-entropy deployment
 * secret rather than a user password, so a per-deployment salt would add a second
 * losable secret without adding real protection. scrypt rather than a bare hash
 * because dev and small deployments will feed this a low-entropy string, and because
 * authCrypto.ts already uses scrypt — this aligns the two.
 */
const KEK_SALT = Buffer.from('xperiment.kek.v1', 'utf8');
const KEY_ID_DOMAIN = 'xperiment.keyid.v1';
const KEY_LEN = 32;

export interface KeyProvider {
  readonly name: 'local' | 'gcp-kms';
  /** Non-secret identity of the root key, stored in workspace_keys.root_key_id. */
  readonly keyId: string;
  wrap(plaintextKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

/**
 * The structural subset of @google-cloud/kms's KeyManagementServiceClient that we
 * use. Declared here, tuple return shape included, so a test fake cannot drift from
 * the real client's signature.
 */
export interface KmsClientLike {
  encrypt(req: {
    name: string;
    plaintext: Buffer;
  }): Promise<[{ ciphertext?: Uint8Array | string | null }, ...unknown[]]>;
  decrypt(req: {
    name: string;
    ciphertext: Buffer;
  }): Promise<[{ plaintext?: Uint8Array | string | null }, ...unknown[]]>;
}

function toBuffer(v: Uint8Array | string | null | undefined): Buffer | null {
  if (v === null || v === undefined) return null;
  // The gRPC transport returns bytes; the REST transport returns base64.
  return typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.from(v);
}

export function localKeyProvider(masterSecret: string): KeyProvider {
  let derived: Promise<Buffer> | null = null;
  // scrypt is deliberately slow; derive once per provider, not per operation.
  const rootKey = (): Promise<Buffer> => (derived ??= scryptAsync(masterSecret, KEK_SALT, KEY_LEN));
  const keyId = `local:${createHash('sha256').update(`${KEY_ID_DOMAIN}:${masterSecret}`).digest('hex').slice(0, 16)}`;
  return {
    name: 'local',
    keyId,
    async wrap(plaintextKey) {
      return sealBytes(plaintextKey, await rootKey());
    },
    async unwrap(wrapped) {
      return openBytes(wrapped, await rootKey());
    },
  };
}

export function gcpKmsKeyProvider(args: { keyName: string; client: KmsClientLike }): KeyProvider {
  return {
    name: 'gcp-kms',
    keyId: args.keyName,
    async wrap(plaintextKey) {
      const [res] = await args.client.encrypt({ name: args.keyName, plaintext: plaintextKey });
      const out = toBuffer(res.ciphertext);
      if (!out?.length) throw new Error('KMS encrypt returned no ciphertext');
      return out;
    },
    async unwrap(wrapped) {
      const [res] = await args.client.decrypt({ name: args.keyName, ciphertext: wrapped });
      const out = toBuffer(res.plaintext);
      if (!out?.length) throw new Error('KMS decrypt returned no plaintext');
      return out;
    },
  };
}

const DEFAULT_LOCAL_MASTER = 'xperiment-dev-kek-master-change-me';

/**
 * Startup-time provider selection. A misconfiguration throws here rather than on the
 * first credential resolution, so a deployment fails to boot instead of failing every
 * workflow at run time.
 *
 * `clientFactory` is injectable so tests never construct a real KMS client — which
 * would resolve application default credentials — and so @google-cloud/kms is
 * imported only when it is actually used.
 */
export async function createKeyProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  clientFactory?: (keyName: string) => Promise<KmsClientLike>,
): Promise<KeyProvider> {
  const provider = env['KMS_PROVIDER'] ?? 'local';
  if (provider === 'local') {
    return localKeyProvider(env['KEK_MASTER_KEY'] ?? DEFAULT_LOCAL_MASTER);
  }
  if (provider !== 'gcp-kms') {
    throw new Error(`Unsupported KMS_PROVIDER '${provider}' — expected 'local' or 'gcp-kms'`);
  }
  const keyName = env['KMS_KEY_NAME'];
  if (!keyName) throw new Error('KMS_KEY_NAME is required when KMS_PROVIDER=gcp-kms');
  const factory = clientFactory ?? defaultKmsClientFactory;
  return gcpKmsKeyProvider({ keyName, client: await factory(keyName) });
}

/**
 * Credentials come from the ambient environment only — GOOGLE_APPLICATION_CREDENTIALS
 * or the instance metadata service. Nothing here reads a key file path from config.
 */
async function defaultKmsClientFactory(_keyName: string): Promise<KmsClientLike> {
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  return new KeyManagementServiceClient() as unknown as KmsClientLike;
}
