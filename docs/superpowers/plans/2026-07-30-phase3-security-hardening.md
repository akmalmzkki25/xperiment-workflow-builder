# Phase 3P — Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every stored credential under per-workspace envelope encryption backed by a real cloud KMS, and give the platform one audit table that records credential use and authentication events.

**Architecture:** A three-tier key hierarchy — a KMS root KEK wraps a per-workspace KEK, which wraps a per-secret DEK. Call sites talk only to a `SecretVault`, never to a key. A new `audit_events` table replaces `auth_events` as the write target and gains credential lifecycle and read-use events, emitted inside the transaction of whatever mutation they describe.

**Tech Stack:** TypeScript (ESM, run directly by tsx — no build step), Node 20 `node:crypto`, Postgres 16 via `pg`, Fastify 5, Vitest 2 with v8 coverage, commander for the CLI, `@google-cloud/kms` 5.7.0.

**Spec:** `docs/superpowers/specs/2026-07-30-phase3-security-hardening-design.md` (commit `e008caf`).

## Global Constraints

- Coverage thresholds are 80% on lines, statements, functions **and** branches, per package. A task is not done until `pnpm --filter <pkg> test:cov` passes.
- `pnpm --filter <pkg> typecheck` must pass. TypeScript is strict with `noUncheckedIndexedAccess`, so indexed reads need `!` or a guard.
- Conventional commit messages: `<type>: <description>`. **No attribution trailer, no `Co-Authored-By`.**
- No `console.log` in application code. The CLI already uses `console.log` for its output; that is the one exception and it is pre-existing.
- **Never log, return, or put in an error message: a plaintext secret, a connection payload, a DEK, a KEK, or a raw webhook body.** Audit `metadata` is typed to scalars and built field-by-field at the call site — never a spread of a request body or provider response.
- No cloud credential appears in any source file. `KMS_KEY_NAME` and the service-account path come from the process environment only.
- Integer money, `SMALLINT` versions, `BIGSERIAL` ids. node-postgres returns `int8` as a **string**, so audit event ids and cursors are `string` in TypeScript.
- Postgres `DATE` is parsed by node-postgres into **local** midnight. This plan touches no DATE column; if one appears, follow `packages/db/src/repos/invoices.ts` (`day()` / `dateParam()`).
- Docker Postgres and Redis must be running: `docker compose up -d`. Tests hit the real database.

**One deliberate reading of the spec.** §3 says `deriveTriggerKey` is deleted; §11 says the legacy env keys stay configured until backfill completes. Both are true only if the derivation survives under a different name. This plan **renames** it to `deriveLegacyKey`, keeps it exported (the vault constructors need it), and documents that it exists solely to read `enc_version = 0` blobs. The misleading name — it derived the credentials key too — goes away, which was the point.

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `packages/db/src/crypto/keyProvider.ts` | `KeyProvider` contract, `localKeyProvider`, `gcpKmsKeyProvider`, `KmsClientLike`, `createKeyProviderFromEnv` |
| `packages/db/src/crypto/keyring.ts` | `WorkspaceKeyring` — get-or-create a workspace KEK, TTL cache |
| `packages/db/src/crypto/vault.ts` | `SecretVault`, the v1 blob codec, the v0 fallback |
| `packages/db/src/crypto/rekey.ts` | `rekeyAll` — resumable v0 → v1 backfill |
| `packages/db/src/repos/audit.ts` | `appendAuditEvent`, `listAuditEvents` |
| `packages/db/src/migrations/0012_security.sql` | `workspace_keys`, `audit_events`, four `enc_version` columns |
| `apps/api/src/routes/audit.ts` | `GET /v1/audit` |
| `packages/db/test/keyProvider.test.ts` | |
| `packages/db/test/keyring.test.ts` | |
| `packages/db/test/vault.test.ts` | |
| `packages/db/test/rekey.test.ts` | |
| `packages/db/test/audit.test.ts` | |
| `apps/api/test/audit.test.ts` | |

**Modify**

`packages/db/src/crypto.ts`, `packages/db/src/index.ts`, `packages/db/package.json`, the four repos that carry an encrypted column (`connections`, `triggers`, `workflows`, `alerts`), `packages/db/src/repos/auth.ts` (api-key id), `apps/api/src/{server.ts,routes/deps.ts,auth/plugin.ts,auth/permissions.ts}`, `apps/api/src/routes/{connections,triggers,workflows,alerts,auth}.ts`, `apps/gateway/src/{main.ts,server.ts}`, `apps/worker/src/{main.ts,runTask.ts,callback.ts,alertDelivery.ts}`, `apps/cli/src/main.ts`, `apps/cli/package.json`, and the eleven test files that reference `deriveTriggerKey`.

**Sequencing rule.** Tasks 1–8 are purely additive: every intermediate state compiles and every existing test keeps passing, because `triggerKey`/`credentialsKey` stay in place beside the new vaults. Tasks 9–13 migrate call sites one surface at a time. Task 14 removes the legacy fields and tightens `getConnectionWithPayload`. Do not reorder — an early tightening breaks compilation across four apps at once.

---

### Task 1: Byte-level crypto primitives with AAD

The vault wraps a 32-byte DEK, not a string, and binds the workspace id as additional authenticated data. Today's primitives are string-only and have no AAD. Generalise them so `encryptSecret`/`decryptSecret` become thin wrappers and the v0 wire format is provably unchanged.

**Files:**
- Modify: `packages/db/src/crypto.ts`
- Modify: `packages/db/src/index.ts:7`
- Test: `packages/db/test/crypto.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sealBytes(plaintext: Buffer, key: Buffer, aad?: Buffer): Buffer`, `openBytes(buf: Buffer, key: Buffer, aad?: Buffer): Buffer`, `encryptSecret(plaintext: string, key: Buffer): Buffer` (unchanged signature), `decryptSecret(buf: Buffer, key: Buffer): string` (unchanged signature), `deriveLegacyKey(envValue: string): Buffer`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `packages/db/test/crypto.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @xperiment/db exec vitest run test/crypto.test.ts
```

Expected: FAIL — `deriveLegacyKey`, `sealBytes` and `openBytes` are not exported.

- [ ] **Step 3: Rewrite `packages/db/src/crypto.ts`**

```ts
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
 * AES-256-GCM over raw bytes, emitting `iv || tag || ciphertext`. This layout is
 * the on-disk format of every legacy secret, so it must not change.
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
```

- [ ] **Step 4: Update the package export**

In `packages/db/src/index.ts`, replace line 7:

```ts
export { deriveLegacyKey, encryptSecret, decryptSecret, openBytes, sealBytes } from './crypto.js';
```

- [ ] **Step 5: Rename the 30 remaining call sites**

`deriveTriggerKey` no longer exists. Rename every reference — imports and calls — in these files:

```
apps/api/src/server.ts
apps/api/test/callback.test.ts
apps/gateway/src/main.ts
apps/gateway/test/gateway.test.ts
apps/worker/src/main.ts
apps/worker/test/alertDelivery.test.ts
apps/worker/test/callback.test.ts
apps/worker/test/connections.test.ts
apps/worker/test/runTask.test.ts
apps/worker/test/suspend.test.ts
packages/db/test/connections.test.ts
```

Verify none are left:

```bash
cd "<repo-root>" && grep -rn "deriveTriggerKey" --include=*.ts . | grep -v node_modules
```

Expected: no output.

- [ ] **Step 6: Run the db suite and typecheck**

```bash
pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck
```

Expected: PASS. The v0-format test is the one that matters — it proves existing rows still decrypt.

- [ ] **Step 7: Run every suite that touched the rename**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/gateway test && pnpm --filter @xperiment/worker test
```

Expected: PASS, no behaviour change.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/crypto.ts packages/db/src/index.ts packages/db/test/crypto.test.ts apps packages/db/test/connections.test.ts
git commit -m "refactor: generalise the secret primitives to bytes with optional AAD"
```

---

### Task 2: `KeyProvider` — local and GCP KMS

**Files:**
- Create: `packages/db/src/crypto/keyProvider.ts`
- Modify: `packages/db/package.json`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/keyProvider.test.ts`

**Interfaces:**
- Consumes: `sealBytes`, `openBytes` from Task 1.
- Produces:
  ```ts
  interface KeyProvider {
    readonly name: 'local' | 'gcp-kms';
    readonly keyId: string;
    wrap(plaintextKey: Buffer): Promise<Buffer>;
    unwrap(wrapped: Buffer): Promise<Buffer>;
  }
  interface KmsClientLike {
    encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext?: Uint8Array | string | null }, ...unknown[]]>;
    decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext?: Uint8Array | string | null }, ...unknown[]]>;
  }
  function localKeyProvider(masterSecret: string): KeyProvider;
  function gcpKmsKeyProvider(args: { keyName: string; client: KmsClientLike }): KeyProvider;
  function createKeyProviderFromEnv(
    env?: NodeJS.ProcessEnv,
    clientFactory?: (keyName: string) => Promise<KmsClientLike>,
  ): Promise<KeyProvider>;
  ```

- [ ] **Step 1: Add the dependency**

In `packages/db/package.json`, add to `dependencies` (keep the existing two):

```json
"@google-cloud/kms": "^5.7.0",
```

Then:

```bash
cd "<repo-root>" && pnpm install
```

- [ ] **Step 2: Write the failing test**

Create `packages/db/test/keyProvider.test.ts`:

```ts
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
    const p = await createKeyProviderFromEnv(
      { KMS_PROVIDER: 'gcp-kms', KMS_KEY_NAME: KEY_NAME },
      factory,
    );
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
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/keyProvider.test.ts
```

Expected: FAIL — `Cannot find module '../src/crypto/keyProvider.js'`.

- [ ] **Step 4: Implement `packages/db/src/crypto/keyProvider.ts`**

```ts
import { createHash, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { openBytes, sealBytes } from '../crypto.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * Fixed salt, deliberately not configuration. The input is a high-entropy
 * deployment secret rather than a user password, so a per-deployment salt would add
 * a second losable secret without adding real protection. scrypt rather than a bare
 * hash because dev and small deployments will feed this a low-entropy string, and
 * because authCrypto.ts already uses scrypt — this aligns the two.
 */
const KEK_SALT = Buffer.from('xperiment.kek.v1', 'utf8');
const KEY_ID_DOMAIN = 'xperiment.keyid.v1';

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
  const rootKey = (): Promise<Buffer> => (derived ??= scryptAsync(masterSecret, KEK_SALT, 32));
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
 * first credential resolution, so a deployment fails to boot instead of failing
 * every workflow at run time.
 *
 * `clientFactory` is injectable so tests never construct a real KMS client, and so
 * @google-cloud/kms is imported only when it is actually used.
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
  const factory =
    clientFactory ??
    (async (name: string): Promise<KmsClientLike> => {
      const { KeyManagementServiceClient } = await import('@google-cloud/kms');
      void name;
      return new KeyManagementServiceClient() as unknown as KmsClientLike;
    });
  return gcpKmsKeyProvider({ keyName, client: await factory(keyName) });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/db exec vitest run test/keyProvider.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 6: Export from the package**

Append to `packages/db/src/index.ts`:

```ts
export {
  createKeyProviderFromEnv,
  gcpKmsKeyProvider,
  localKeyProvider,
  type KeyProvider,
  type KmsClientLike,
} from './crypto/keyProvider.js';
```

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @xperiment/db typecheck
git add packages/db/package.json packages/db/src/crypto/keyProvider.ts packages/db/src/index.ts packages/db/test/keyProvider.test.ts pnpm-lock.yaml
git commit -m "feat: add the KeyProvider contract with local and GCP KMS providers"
```

---

### Task 3: Migration 0012 — `workspace_keys`, `audit_events`, four version columns

**Files:**
- Create: `packages/db/src/migrations/0012_security.sql`
- Test: `packages/db/test/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `workspace_keys`, `audit_events`; columns `connections.enc_version`, `workflow_triggers.secret_enc_version`, `workflows.completion_webhook_enc_version`, `alert_rules.webhook_secret_enc_version`, all `SMALLINT NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/migrate.test.ts`, inside the existing top-level `describe`:

```ts
  test('0012 adds a version column to every encrypted column, defaulting existing rows to 0', async () => {
    const r = await pool.query<{ table_name: string; column_name: string; column_default: string; is_nullable: string }>(
      `SELECT table_name, column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE (table_name, column_name) IN (
         ('connections','enc_version'),
         ('workflow_triggers','secret_enc_version'),
         ('workflows','completion_webhook_enc_version'),
         ('alert_rules','webhook_secret_enc_version'))
       ORDER BY table_name`,
    );
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) {
      expect(row.column_default, row.table_name).toContain('0');
      expect(row.is_nullable, row.table_name).toBe('NO');
    }
  });

  test('workspace_keys is keyed one-per-workspace and cascades on workspace delete', async () => {
    const pk = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'workspace_keys'::regclass AND i.indisprimary`,
    );
    expect(pk.rows.map((r) => r.column_name)).toEqual(['workspace_id']);
    const fk = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'workspace_keys'::regclass AND contype = 'f'`,
    );
    expect(fk.rows.map((r) => r.confdeltype)).toEqual(['c']); // 'c' = ON DELETE CASCADE
  });

  test('audit_events keeps the actor record when the user row is deleted', async () => {
    const fk = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'audit_events'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    const byCol = new Map(fk.rows.map((r) => [r.conname, r.confdeltype]));
    // The user and api-key references null out; the workspace reference cascades.
    expect([...byCol.values()].filter((t) => t === 'n')).toHaveLength(2);
    expect([...byCol.values()].filter((t) => t === 'c')).toHaveLength(1);
  });

  test('audit_events rejects an unknown actor_kind and an unknown outcome', async () => {
    await expect(
      pool.query(`INSERT INTO audit_events (actor_kind, action) VALUES ('robot', 'x')`),
    ).rejects.toThrow();
    await expect(
      pool.query(`INSERT INTO audit_events (actor_kind, action, outcome) VALUES ('system', 'x', 'maybe')`),
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/migrate.test.ts
```

Expected: FAIL — `relation "workspace_keys" does not exist`.

- [ ] **Step 3: Write `packages/db/src/migrations/0012_security.sql`**

```sql
-- SEC-001: per-workspace key material. One row per workspace, holding that
-- workspace's KEK wrapped by the deployment's root key. Deleting the row makes
-- every secret in the workspace permanently undecryptable — that is the
-- crypto-shredding property WS-010 needs, so the CASCADE is intentional.
CREATE TABLE workspace_keys (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  root_key_id  TEXT NOT NULL,
  wrapped_key  BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at   TIMESTAMPTZ NULL
);

-- Out-of-band format discriminator. A legacy blob begins with a random 12-byte IV,
-- so an in-band marker would be ambiguous for roughly 1 in 256 rows. DEFAULT 0 is
-- what makes this migration safe on existing data; new rows pass 1 explicitly.
ALTER TABLE connections       ADD COLUMN enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE workflow_triggers ADD COLUMN secret_enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE workflows         ADD COLUMN completion_webhook_enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE alert_rules       ADD COLUMN webhook_secret_enc_version SMALLINT NOT NULL DEFAULT 0;

-- SEC-009. Replaces auth_events as the write target; auth_events is left in place as
-- historical data. workspace_id is nullable because a failed login for an unknown
-- email belongs to no workspace — and GET /v1/audit must never return those rows.
CREATE TABLE audit_events (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     UUID NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('user','api_key','system','anonymous')),
  actor_user_id    UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_api_key_id UUID NULL REFERENCES api_keys(id) ON DELETE SET NULL,
  actor_label      TEXT NULL,
  action           TEXT NOT NULL,
  target_type      TEXT NULL,
  -- TEXT, not UUID: a trigger target is identified by IR node id.
  target_id        TEXT NULL,
  outcome          TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure')),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id       TEXT NULL,
  ip               TEXT NULL,
  user_agent       TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ordering and pagination are on id, not created_at: created_at defaults to now(),
-- which is transaction start time, so a long transaction can commit a row with an
-- earlier created_at than one already visible. BIGSERIAL is monotonic in insert order.
CREATE INDEX idx_audit_events_ws ON audit_events (workspace_id, id DESC);
CREATE INDEX idx_audit_events_target ON audit_events (workspace_id, target_type, target_id, id DESC);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/db exec vitest run test/migrate.test.ts
```

Expected: PASS. The migration runner applies files in sorted order and records them in `schema_migrations`, so this runs once against the dev database.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/0012_security.sql packages/db/test/migrate.test.ts
git commit -m "feat: add the workspace key and audit event schema"
```

---

### Task 4: `WorkspaceKeyring`

The get-or-create protocol is the one place a race can silently split a workspace's key material. It follows the same three-statement shape 3N used for quota counters, and the third statement — the unconditional re-read — is what makes it correct.

**Files:**
- Create: `packages/db/src/crypto/keyring.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/keyring.test.ts`

**Interfaces:**
- Consumes: `KeyProvider` (Task 2), `workspace_keys` (Task 3).
- Produces:
  ```ts
  interface WorkspaceKeyring {
    keyFor(workspaceId: string): Promise<Buffer>;
    invalidate(workspaceId: string): void;
  }
  function createWorkspaceKeyring(args: { pool: pg.Pool; provider: KeyProvider; ttlMs?: number }): WorkspaceKeyring;
  const DEFAULT_KEK_CACHE_TTL_MS = 300000;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/keyring.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, runMigrations } from '../src/index.js';
import { localKeyProvider, type KeyProvider } from '../src/crypto/keyProvider.js';
import { createWorkspaceKeyring } from '../src/crypto/keyring.js';

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE workspace_keys CASCADE`);
});

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [id, `ws-${id.slice(0, 8)}`]);
  return id;
}

/** Wraps a provider to count how many times the root key was consulted. */
function counting(inner: KeyProvider): KeyProvider & { wraps: number; unwraps: number } {
  const p = {
    name: inner.name,
    keyId: inner.keyId,
    wraps: 0,
    unwraps: 0,
    async wrap(k: Buffer) {
      p.wraps += 1;
      return inner.wrap(k);
    },
    async unwrap(w: Buffer) {
      p.unwraps += 1;
      return inner.unwrap(w);
    },
  };
  return p;
}

describe('WorkspaceKeyring', () => {
  test('creates a 32-byte KEK on first use and records the provider identity', async () => {
    const ws = await makeWorkspace();
    const provider = localKeyProvider('m');
    const keyring = createWorkspaceKeyring({ pool, provider });
    const key = await keyring.keyFor(ws);
    expect(key.length).toBe(32);
    const row = await pool.query<{ provider: string; root_key_id: string; wrapped_key: Buffer }>(
      `SELECT provider, root_key_id, wrapped_key FROM workspace_keys WHERE workspace_id = $1`,
      [ws],
    );
    expect(row.rows[0]!.provider).toBe('local');
    expect(row.rows[0]!.root_key_id).toBe(provider.keyId);
    // At rest it is ciphertext, never the KEK itself.
    expect(row.rows[0]!.wrapped_key.equals(key)).toBe(false);
  });

  test('the second call is served from cache without touching the provider', async () => {
    const ws = await makeWorkspace();
    const provider = counting(localKeyProvider('m'));
    const keyring = createWorkspaceKeyring({ pool, provider });
    const a = await keyring.keyFor(ws);
    const before = provider.unwraps;
    const b = await keyring.keyFor(ws);
    expect(a.equals(b)).toBe(true);
    expect(provider.unwraps).toBe(before);
  });

  test('an expired entry is re-unwrapped and yields the same key', async () => {
    const ws = await makeWorkspace();
    const provider = counting(localKeyProvider('m'));
    const keyring = createWorkspaceKeyring({ pool, provider, ttlMs: 0 });
    const a = await keyring.keyFor(ws);
    const b = await keyring.keyFor(ws);
    expect(a.equals(b)).toBe(true);
    expect(provider.unwraps).toBeGreaterThanOrEqual(1);
  });

  test('invalidate forces the next call back to the provider', async () => {
    const ws = await makeWorkspace();
    const provider = counting(localKeyProvider('m'));
    const keyring = createWorkspaceKeyring({ pool, provider });
    await keyring.keyFor(ws);
    const before = provider.unwraps;
    keyring.invalidate(ws);
    await keyring.keyFor(ws);
    expect(provider.unwraps).toBe(before + 1);
  });

  test('concurrent first use across independent keyrings converges on ONE key', async () => {
    // The regression this exists for: without the unconditional re-read after
    // INSERT ... ON CONFLICT DO NOTHING, the loser keeps its own locally generated
    // KEK, and the two halves of the workspace get encrypted under different keys.
    // Separate keyring instances are essential — a shared cache would hide it.
    const workspaces = await Promise.all([makeWorkspace(), makeWorkspace(), makeWorkspace(), makeWorkspace()]);
    const provider = localKeyProvider('m');
    for (const ws of workspaces) {
      const rings = [
        createWorkspaceKeyring({ pool, provider }),
        createWorkspaceKeyring({ pool, provider }),
        createWorkspaceKeyring({ pool, provider }),
      ];
      const keys = await Promise.all(rings.map((r) => r.keyFor(ws)));
      const first = keys[0]!;
      for (const k of keys) expect(k.equals(first), `workspace ${ws}`).toBe(true);
      const count = await pool.query<{ c: string }>(
        `SELECT count(*) AS c FROM workspace_keys WHERE workspace_id = $1`,
        [ws],
      );
      expect(count.rows[0]!.c).toBe('1');
    }
  });

  test('a KEK created before a restart is recovered, not regenerated', async () => {
    const ws = await makeWorkspace();
    const provider = localKeyProvider('m');
    const before = await createWorkspaceKeyring({ pool, provider }).keyFor(ws);
    const after = await createWorkspaceKeyring({ pool, provider }).keyFor(ws);
    expect(after.equals(before)).toBe(true);
  });

  test('a corrupted wrapped key surfaces as an error, not as a wrong key', async () => {
    const ws = await makeWorkspace();
    const provider = localKeyProvider('m');
    await createWorkspaceKeyring({ pool, provider }).keyFor(ws);
    await pool.query(`UPDATE workspace_keys SET wrapped_key = $1 WHERE workspace_id = $2`, [
      Buffer.alloc(60, 7),
      ws,
    ]);
    await expect(createWorkspaceKeyring({ pool, provider }).keyFor(ws)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/keyring.test.ts
```

Expected: FAIL — `Cannot find module '../src/crypto/keyring.js'`.

- [ ] **Step 3: Verify the race test actually detects the bug**

This step exists because a race test that passes against broken code is worse than no test. Implement Step 4 first, then come back here.

- [ ] **Step 4: Implement `packages/db/src/crypto/keyring.ts`**

```ts
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { KeyProvider } from './keyProvider.js';

export const DEFAULT_KEK_CACHE_TTL_MS = 300000;

export interface WorkspaceKeyring {
  /** The workspace's KEK in plaintext, creating and persisting one on first use. */
  keyFor(workspaceId: string): Promise<Buffer>;
  invalidate(workspaceId: string): void;
}

interface CacheEntry {
  key: Buffer;
  expiresAt: number;
}

/**
 * Takes a Pool, not a Db, on purpose. KEK creation must commit independently of the
 * caller's transaction: if it joined that transaction and the caller rolled back, the
 * cache would still hold a KEK whose row no longer exists, and everything encrypted
 * under it afterwards would be unreadable. An orphan KEK row with no secrets is
 * harmless; the reverse is not.
 */
export function createWorkspaceKeyring(args: {
  pool: pg.Pool;
  provider: KeyProvider;
  ttlMs?: number;
}): WorkspaceKeyring {
  const ttlMs = args.ttlMs ?? DEFAULT_KEK_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  async function load(workspaceId: string): Promise<Buffer> {
    const existing = await args.pool.query<{ wrapped_key: Buffer }>(
      `SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1`,
      [workspaceId],
    );
    const found = existing.rows[0];
    if (found) return args.provider.unwrap(found.wrapped_key);

    const fresh = randomBytes(32);
    const wrapped = await args.provider.wrap(fresh);
    // Round-trip before persisting. A corrupted wrap would otherwise surface much
    // later as an entire workspace of undecryptable credentials.
    const verified = await args.provider.unwrap(wrapped);
    if (!verified.equals(fresh)) throw new Error('key provider failed to round-trip a new workspace key');

    await args.pool.query(
      `INSERT INTO workspace_keys (workspace_id, provider, root_key_id, wrapped_key)
       VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId, args.provider.name, args.provider.keyId, wrapped],
    );
    // Unconditional re-read. If the insert lost the race, `fresh` must be discarded
    // and never used to encrypt anything, or the two racers encrypt this workspace
    // under two different keys and half its secrets become unreadable.
    const settled = await args.pool.query<{ wrapped_key: Buffer }>(
      `SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1`,
      [workspaceId],
    );
    const winner = settled.rows[0];
    if (!winner) throw new Error(`workspace key missing after insert for workspace ${workspaceId}`);
    return args.provider.unwrap(winner.wrapped_key);
  }

  return {
    async keyFor(workspaceId) {
      const hit = cache.get(workspaceId);
      if (hit && hit.expiresAt > Date.now()) return hit.key;
      const key = await load(workspaceId);
      cache.set(workspaceId, { key, expiresAt: Date.now() + ttlMs });
      return key;
    },
    invalidate(workspaceId) {
      cache.delete(workspaceId);
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/db exec vitest run test/keyring.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Deliberately break the guard and confirm the race test fails**

Temporarily replace the re-read block in `load` with the broken version:

```ts
    // BROKEN ON PURPOSE — restore after this step.
    return fresh;
```

Run it three times:

```bash
pnpm --filter @xperiment/db exec vitest run test/keyring.test.ts -t "converges on ONE key"
pnpm --filter @xperiment/db exec vitest run test/keyring.test.ts -t "converges on ONE key"
pnpm --filter @xperiment/db exec vitest run test/keyring.test.ts -t "converges on ONE key"
```

Expected: FAIL all three times — two of the three keyrings return a different key. If it passes even once, the test is not exercising the race: raise the workspace count in the test and add a pool warm-up (`await Promise.all([...Array(5)].map(() => pool.query('SELECT 1')))`) before the concurrent block, because a cold pool serialises the connections and hides it. Then restore the correct implementation and re-run.

- [ ] **Step 7: Export and commit**

Append to `packages/db/src/index.ts`:

```ts
export {
  createWorkspaceKeyring,
  DEFAULT_KEK_CACHE_TTL_MS,
  type WorkspaceKeyring,
} from './crypto/keyring.js';
```

```bash
pnpm --filter @xperiment/db typecheck
git add packages/db/src/crypto/keyring.ts packages/db/src/index.ts packages/db/test/keyring.test.ts
git commit -m "feat: add the per-workspace key ring with a race-safe first use"
```

---

### Task 5: `SecretVault`

**Files:**
- Create: `packages/db/src/crypto/vault.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/vault.test.ts`

**Interfaces:**
- Consumes: `sealBytes`/`openBytes` (Task 1), `WorkspaceKeyring` (Task 4).
- Produces:
  ```ts
  interface EncryptedSecret { blob: Buffer; encVersion: number }
  interface SecretVault {
    encrypt(workspaceId: string, plaintext: string): Promise<EncryptedSecret>;
    decrypt(workspaceId: string, secret: EncryptedSecret): Promise<string>;
  }
  function createSecretVault(args: { keyring: WorkspaceKeyring; legacyKey: Buffer }): SecretVault;
  const ENC_VERSION_LEGACY = 0;
  const ENC_VERSION_ENVELOPE = 1;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/vault.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, deriveLegacyKey, encryptSecret, runMigrations } from '../src/index.js';
import { localKeyProvider } from '../src/crypto/keyProvider.js';
import { createWorkspaceKeyring } from '../src/crypto/keyring.js';
import { createSecretVault, ENC_VERSION_ENVELOPE, ENC_VERSION_LEGACY } from '../src/crypto/vault.js';

let pool: Pool;
const legacyKey = deriveLegacyKey('legacy-secret');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE workspace_keys CASCADE`);
});

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [id, `ws-${id.slice(0, 8)}`]);
  return id;
}

function vault() {
  const keyring = createWorkspaceKeyring({ pool, provider: localKeyProvider('m') });
  return createSecretVault({ keyring, legacyKey });
}

describe('SecretVault', () => {
  test('round-trips a secret at the envelope version', async () => {
    const ws = await makeWorkspace();
    const v = vault();
    const sealed = await v.encrypt(ws, 'tok-abc');
    expect(sealed.encVersion).toBe(ENC_VERSION_ENVELOPE);
    expect(sealed.blob[0]).toBe(1); // format marker
    expect(sealed.blob.toString('utf8')).not.toContain('tok-abc');
    expect(await v.decrypt(ws, sealed)).toBe('tok-abc');
  });

  test('every secret gets its own DEK: two encrypts of one value share no bytes', async () => {
    const ws = await makeWorkspace();
    const v = vault();
    const a = await v.encrypt(ws, 'same');
    const b = await v.encrypt(ws, 'same');
    expect(a.blob.equals(b.blob)).toBe(false);
    expect(await v.decrypt(ws, a)).toBe('same');
    expect(await v.decrypt(ws, b)).toBe('same');
  });

  test('a legacy blob decrypts through the same vault', async () => {
    const ws = await makeWorkspace();
    const legacy = { blob: encryptSecret('old-value', legacyKey), encVersion: ENC_VERSION_LEGACY };
    expect(await vault().decrypt(ws, legacy)).toBe('old-value');
  });

  test('an envelope blob is bound to its workspace and fails in another', async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const v = vault();
    const sealed = await v.encrypt(wsA, 'a-secret');
    await expect(v.decrypt(wsB, sealed)).rejects.toThrow();
  });

  test('a legacy blob labelled as envelope is rejected by the marker check', async () => {
    const ws = await makeWorkspace();
    const mislabelled = { blob: encryptSecret('x', legacyKey), encVersion: ENC_VERSION_ENVELOPE };
    // The version column says v1 but the bytes are v0. Without the marker this would
    // read a random IV byte as a length and produce garbage or a confusing GCM error.
    await expect(vault().decrypt(ws, mislabelled)).rejects.toThrow(/format/i);
  });

  test('an unknown version is rejected by name', async () => {
    const ws = await makeWorkspace();
    const v = vault();
    const sealed = await v.encrypt(ws, 'x');
    await expect(v.decrypt(ws, { blob: sealed.blob, encVersion: 7 })).rejects.toThrow(/enc_version 7/);
  });

  test('a truncated envelope blob throws rather than reading past the end', async () => {
    const ws = await makeWorkspace();
    const v = vault();
    const sealed = await v.encrypt(ws, 'x');
    await expect(v.decrypt(ws, { blob: sealed.blob.subarray(0, 20), encVersion: 1 })).rejects.toThrow();
  });

  test('a tampered payload byte fails the GCM tag', async () => {
    const ws = await makeWorkspace();
    const v = vault();
    const sealed = await v.encrypt(ws, 'x');
    const tampered = Buffer.from(sealed.blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await expect(v.decrypt(ws, { blob: tampered, encVersion: 1 })).rejects.toThrow();
  });

  test('two vaults sharing one keyring interoperate', async () => {
    // The API builds one vault per legacy key family over a shared keyring; a secret
    // written by one must be readable by the other at v1, since v1 has no families.
    const ws = await makeWorkspace();
    const keyring = createWorkspaceKeyring({ pool, provider: localKeyProvider('m') });
    const credentials = createSecretVault({ keyring, legacyKey: deriveLegacyKey('cred') });
    const trigger = createSecretVault({ keyring, legacyKey: deriveLegacyKey('trig') });
    const sealed = await credentials.encrypt(ws, 'shared');
    expect(await trigger.decrypt(ws, sealed)).toBe('shared');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/vault.test.ts
```

Expected: FAIL — `Cannot find module '../src/crypto/vault.js'`.

- [ ] **Step 3: Implement `packages/db/src/crypto/vault.ts`**

```ts
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
 * written under, and there were two (TRIGGER_SECRET_KEY, CREDENTIALS_SECRET_KEY).
 * Both vaults share one keyring so the split does not double KMS traffic. From v1
 * onward the families merge: every secret in a workspace is under that workspace's KEK.
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
      // assertion, so a blob and version that drifted apart fail loudly.
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/db exec vitest run test/vault.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Export and commit**

Append to `packages/db/src/index.ts`:

```ts
export {
  createSecretVault,
  ENC_VERSION_ENVELOPE,
  ENC_VERSION_LEGACY,
  type EncryptedSecret,
  type SecretVault,
} from './crypto/vault.js';
```

```bash
pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/db test
git add packages/db/src/crypto/vault.ts packages/db/src/index.ts packages/db/test/vault.test.ts
git commit -m "feat: add the secret vault with per-secret data keys"
```

---

### Task 6: Audit repository

**Files:**
- Create: `packages/db/src/repos/audit.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/audit.test.ts`

**Interfaces:**
- Consumes: `audit_events` (Task 3), `Db` from `packages/db/src/pool.ts` (`pg.Pool | pg.PoolClient`), `withTx` from `packages/db/src/tx.ts`.
- Produces:
  ```ts
  type ActorKind = 'user' | 'api_key' | 'system' | 'anonymous';
  type AuditMetadata = Record<string, string | number | boolean | null>;
  interface AuditEventInput {
    workspaceId?: string | null;
    actorKind: ActorKind;
    actorUserId?: string | null;
    actorApiKeyId?: string | null;
    actorLabel?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    outcome?: 'success' | 'failure';
    metadata?: AuditMetadata;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }
  interface AuditEventRow {
    id: string; workspaceId: string | null; actorKind: ActorKind;
    actorUserId: string | null; actorApiKeyId: string | null; actorLabel: string | null;
    action: string; targetType: string | null; targetId: string | null;
    outcome: 'success' | 'failure'; metadata: AuditMetadata;
    requestId: string | null; ip: string | null; userAgent: string | null; createdAt: string;
  }
  function appendAuditEvent(db: Db, input: AuditEventInput): Promise<void>;
  function listAuditEvents(db: Db, args: {
    workspaceId: string; limit: number; before?: string;
    action?: string; targetType?: string; targetId?: string;
  }): Promise<AuditEventRow[]>;
  const AUDIT_PAGE_MAX = 200;
  ```

`metadata` is typed to scalars so a request body or provider response cannot be spread into it without a compile error. That is the enforcement mechanism for the allowlist rule, not just a convention.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/audit.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, runMigrations, withTx } from '../src/index.js';
import { appendAuditEvent, listAuditEvents } from '../src/repos/audit.js';

let pool: Pool;
let ws: string;
let other: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
  ws = randomUUID();
  other = randomUUID();
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1,'a'), ($2,'b')`, [ws, other]);
});

describe('appendAuditEvent', () => {
  test('stores the actor, target, outcome and metadata', async () => {
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'x')`, [
      userId,
      `u-${userId.slice(0, 8)}@example.com`,
    ]);
    await appendAuditEvent(pool, {
      workspaceId: ws,
      actorKind: 'user',
      actorUserId: userId,
      action: 'credential.create',
      targetType: 'connection',
      targetId: 'conn-1',
      metadata: { connectorKey: 'telegram' },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: ws,
      actorKind: 'user',
      actorUserId: userId,
      action: 'credential.create',
      targetType: 'connection',
      targetId: 'conn-1',
      outcome: 'success',
      metadata: { connectorKey: 'telegram' },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    expect(typeof rows[0]!.id).toBe('string'); // BIGSERIAL arrives as a string
  });

  test('records a failure outcome and an anonymous actor with only a label', async () => {
    await appendAuditEvent(pool, {
      actorKind: 'anonymous',
      actorLabel: 'nobody@example.com',
      action: 'auth.login_failed',
      outcome: 'failure',
    });
    const raw = await pool.query<{ workspace_id: string | null; outcome: string; actor_label: string }>(
      `SELECT workspace_id, outcome, actor_label FROM audit_events`,
    );
    expect(raw.rows[0]).toMatchObject({ workspace_id: null, outcome: 'failure', actor_label: 'nobody@example.com' });
  });

  test('an event emitted inside a rolled-back transaction leaves no row', async () => {
    // The 3M lesson: an audit row must not survive a mutation that was undone.
    await expect(
      withTx(pool, async (client) => {
        await appendAuditEvent(client, { workspaceId: ws, actorKind: 'system', action: 'credential.delete' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(rows).toHaveLength(0);
  });

  test('an event emitted inside a committed transaction leaves exactly one row', async () => {
    await withTx(pool, async (client) => {
      await appendAuditEvent(client, { workspaceId: ws, actorKind: 'system', action: 'credential.delete' });
    });
    expect(await listAuditEvents(pool, { workspaceId: ws, limit: 10 })).toHaveLength(1);
  });
});

describe('listAuditEvents', () => {
  async function seed(n: number, workspaceId: string, action = 'credential.read_use'): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await appendAuditEvent(pool, {
        workspaceId,
        actorKind: 'system',
        action,
        targetType: 'connection',
        targetId: `c-${i}`,
        metadata: { i },
      });
    }
  }

  test('newest first, and never another workspace’s rows', async () => {
    await seed(3, ws);
    await seed(2, other);
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.targetId)).toEqual(['c-2', 'c-1', 'c-0']);
  });

  test('a global row is never returned to a workspace', async () => {
    await appendAuditEvent(pool, { actorKind: 'anonymous', action: 'auth.login_failed', outcome: 'failure' });
    expect(await listAuditEvents(pool, { workspaceId: ws, limit: 10 })).toHaveLength(0);
  });

  test('keyset pagination returns each row exactly once', async () => {
    await seed(7, ws);
    const first = await listAuditEvents(pool, { workspaceId: ws, limit: 3 });
    const second = await listAuditEvents(pool, { workspaceId: ws, limit: 3, before: first[2]!.id });
    const third = await listAuditEvents(pool, { workspaceId: ws, limit: 3, before: second[2]!.id });
    const seen = [...first, ...second, ...third].map((r) => r.targetId);
    expect(seen).toEqual(['c-6', 'c-5', 'c-4', 'c-3', 'c-2', 'c-1', 'c-0']);
    expect(new Set(seen).size).toBe(7);
  });

  test('filters by action and by target', async () => {
    await seed(2, ws, 'credential.read_use');
    await seed(1, ws, 'credential.create');
    expect(await listAuditEvents(pool, { workspaceId: ws, limit: 10, action: 'credential.create' })).toHaveLength(1);
    const byTarget = await listAuditEvents(pool, {
      workspaceId: ws,
      limit: 10,
      targetType: 'connection',
      targetId: 'c-0',
    });
    expect(byTarget.map((r) => r.action).sort()).toEqual(['credential.create', 'credential.read_use']);
  });

  test('the limit is clamped rather than trusted', async () => {
    await seed(3, ws);
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 100000 });
    expect(rows).toHaveLength(3); // clamped to AUDIT_PAGE_MAX, not rejected
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/audit.test.ts
```

Expected: FAIL — `Cannot find module '../src/repos/audit.js'`.

- [ ] **Step 3: Implement `packages/db/src/repos/audit.ts`**

```ts
import { type Db } from '../pool.js';

export const AUDIT_PAGE_MAX = 200;

export type ActorKind = 'user' | 'api_key' | 'system' | 'anonymous';

/**
 * Scalars only, on purpose. A request body, a connector payload or a provider
 * response may carry a secret, so spreading one into an audit row must not typecheck.
 * Build metadata field by field at the call site.
 */
export type AuditMetadata = Record<string, string | number | boolean | null>;

export interface AuditEventInput {
  workspaceId?: string | null;
  actorKind: ActorKind;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  /** Email for an anonymous attempt, or a retained label once the user row is gone. */
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'failure';
  metadata?: AuditMetadata;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEventRow {
  /** BIGSERIAL: node-postgres returns int8 as a string, and it is the page cursor. */
  id: string;
  workspaceId: string | null;
  actorKind: ActorKind;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'failure';
  metadata: AuditMetadata;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

function mapEvent(r: Record<string, unknown>): AuditEventRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
  return {
    id: String(r['id']),
    workspaceId: (r['workspace_id'] as string | null) ?? null,
    actorKind: r['actor_kind'] as ActorKind,
    actorUserId: (r['actor_user_id'] as string | null) ?? null,
    actorApiKeyId: (r['actor_api_key_id'] as string | null) ?? null,
    actorLabel: (r['actor_label'] as string | null) ?? null,
    action: r['action'] as string,
    targetType: (r['target_type'] as string | null) ?? null,
    targetId: (r['target_id'] as string | null) ?? null,
    outcome: r['outcome'] as 'success' | 'failure',
    metadata: (r['metadata'] as AuditMetadata | null) ?? {},
    requestId: (r['request_id'] as string | null) ?? null,
    ip: (r['ip'] as string | null) ?? null,
    userAgent: (r['user_agent'] as string | null) ?? null,
    createdAt: ts(r['created_at']),
  };
}

/**
 * Pass a transaction client when the event describes a mutation, so the row commits
 * or rolls back with it. Pass the pool for events that mutate nothing — a read-use,
 * a failed login.
 */
export async function appendAuditEvent(db: Db, input: AuditEventInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (workspace_id, actor_kind, actor_user_id, actor_api_key_id, actor_label,
        action, target_type, target_id, outcome, metadata, request_id, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'success'),COALESCE($10::jsonb,'{}'::jsonb),$11,$12,$13)`,
    [
      input.workspaceId ?? null,
      input.actorKind,
      input.actorUserId ?? null,
      input.actorApiKeyId ?? null,
      input.actorLabel ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.outcome ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.requestId ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
}

/**
 * Ordered and paginated on `id`, not `created_at`. created_at is now(), which is
 * transaction start time, so a long transaction can commit a row with an earlier
 * timestamp than one already visible — and ties on a timestamp make the order
 * nondeterministic. BIGSERIAL is monotonic in insert order.
 *
 * Rows with workspace_id IS NULL are global (a failed login for an unknown email) and
 * are never returned here.
 */
export async function listAuditEvents(
  db: Db,
  args: {
    workspaceId: string;
    limit: number;
    before?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
  },
): Promise<AuditEventRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(args.limit)), AUDIT_PAGE_MAX);
  const r = await db.query(
    `SELECT * FROM audit_events
     WHERE workspace_id = $1
       AND ($2::bigint IS NULL OR id < $2::bigint)
       AND ($3::text IS NULL OR action = $3)
       AND ($4::text IS NULL OR target_type = $4)
       AND ($5::text IS NULL OR target_id = $5)
     ORDER BY id DESC
     LIMIT $6`,
    [args.workspaceId, args.before ?? null, args.action ?? null, args.targetType ?? null, args.targetId ?? null, limit],
  );
  return (r.rows as Record<string, unknown>[]).map(mapEvent);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/db exec vitest run test/audit.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Export and commit**

Append to `packages/db/src/index.ts`:

```ts
export * from './repos/audit.js';
```

```bash
pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/db test:cov
git add packages/db/src/repos/audit.ts packages/db/src/index.ts packages/db/test/audit.test.ts
git commit -m "feat: add the audit event repository"
```

Expected: coverage thresholds met on the db package.

---

### Task 7: Widen the four secret-bearing repositories

Additive only: new fields on the way out, new optional parameters on the way in. Nothing that already compiles stops compiling, so the call-site migration in Tasks 9–12 can go one surface at a time.

**Files:**
- Modify: `packages/db/src/repos/connections.ts:22-53`
- Modify: `packages/db/src/repos/triggers.ts:5-82`
- Modify: `packages/db/src/repos/workflows.ts:150-162`
- Modify: `packages/db/src/repos/alerts.ts:60-87,210-222`
- Test: `packages/db/test/connections.test.ts`, `packages/db/test/triggers.test.ts`

**Interfaces:**
- Consumes: `ENC_VERSION_LEGACY` / `ENC_VERSION_ENVELOPE` (Task 5).
- Produces:
  - `createConnection(db, { workspaceId, connectorKey, name, encryptedPayload: Buffer, encVersion?: number })`
  - `getConnectionWithPayload(db, id, workspaceId?)` → `(ConnectionRow & { workspaceId: string; encryptedPayload: Buffer; encVersion: number }) | null`
  - `TriggerRow` gains `workspaceId: string` and `secretEncVersion: number`
  - `upsertTrigger(db, { …, secretEncrypted?: Buffer | null, secretEncVersion?: number })`
  - `setWorkflowCallback(db, { workflowId, url, secretEncrypted: Buffer, encVersion?: number })`
  - `getWorkflowCallback(db, workflowId)` → `{ workspaceId: string; url: string; secretEncrypted: Buffer; encVersion: number } | null`
  - `createAlertRule(db, { …, webhookSecretEncrypted?: Buffer, webhookSecretEncVersion?: number })`
  - `getAlertWebhook(db, ruleId)` → `{ workspaceId: string; url: string; secretEncrypted: Buffer; encVersion: number } | null`

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/test/connections.test.ts`, inside the existing `describe('connections repo')`:

```ts
  test('defaults to the legacy version and reports it on read', async () => {
    const row = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'telegram',
      name: 'Legacy',
      encryptedPayload: encryptSecret('{}', key),
    });
    const read = await getConnectionWithPayload(pool, row.id);
    expect(read!.encVersion).toBe(0);
    expect(read!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  test('an explicit version is stored and read back', async () => {
    const row = await createConnection(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectorKey: 'telegram',
      name: 'Enveloped',
      encryptedPayload: Buffer.from([1, 2, 3]),
      encVersion: 1,
    });
    expect((await getConnectionWithPayload(pool, row.id))!.encVersion).toBe(1);
  });
```

Append to `packages/db/test/triggers.test.ts`, inside its top-level `describe`:

```ts
  test('a trigger row carries its workspace and secret version', async () => {
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'T' });
    const t = await upsertTrigger(pool, {
      workflowId: wf.id,
      nodeId: 'n1',
      type: 'webhook',
      authMode: 'token',
      secretEncrypted: Buffer.from([9]),
      secretEncVersion: 1,
    });
    expect(t.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(t.secretEncVersion).toBe(1);
    const fetched = await getTriggerByRouteKey(pool, t.routeKey);
    expect(fetched!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(fetched!.secretEncVersion).toBe(1);
  });

  test('re-upsert keeps the existing secret AND its version together', async () => {
    // The ON CONFLICT clause preserves an existing secret. If the version were
    // overwritten independently, a v1 blob would be labelled v0 and become unreadable.
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'T2' });
    const first = await upsertTrigger(pool, {
      workflowId: wf.id,
      nodeId: 'n1',
      type: 'webhook',
      authMode: 'token',
      secretEncrypted: Buffer.from([1, 1, 1]),
      secretEncVersion: 1,
    });
    const second = await upsertTrigger(pool, {
      workflowId: wf.id,
      nodeId: 'n1',
      type: 'webhook',
      authMode: 'token',
      secretEncrypted: Buffer.from([2, 2, 2]),
      secretEncVersion: 0,
    });
    expect(second.secretEncrypted!.equals(first.secretEncrypted!)).toBe(true);
    expect(second.secretEncVersion).toBe(1);
  });

  test('a first upsert with no prior secret takes the incoming version', async () => {
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'T3' });
    const t = await upsertTrigger(pool, { workflowId: wf.id, nodeId: 'n1', type: 'schedule', cron: '* * * * *' });
    expect(t.secretEncrypted).toBeNull();
    expect(t.secretEncVersion).toBe(0);
  });
```

Add whatever imports these need to the top of each test file (`getTriggerByRouteKey`, `upsertTrigger`, `createWorkflow`, `DEFAULT_WORKSPACE_ID`).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @xperiment/db exec vitest run test/connections.test.ts test/triggers.test.ts
```

Expected: FAIL — `encVersion` and `workspaceId` are `undefined`, and `secretEncVersion` is not a known property.

- [ ] **Step 3: Widen `packages/db/src/repos/connections.ts`**

Replace `mapConnection`, `createConnection` and `getConnectionWithPayload`:

```ts
export interface ConnectionRow {
  id: string;
  connectorKey: string;
  name: string;
  status: string;
  createdAt: string;
}

function mapConnection(r: Record<string, unknown>): ConnectionRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
  return {
    id: r['id'] as string,
    connectorKey: r['connector_key'] as string,
    name: r['name'] as string,
    status: r['status'] as string,
    createdAt: ts(r['created_at']),
  };
}

export async function createConnection(
  db: Db,
  args: {
    workspaceId: string;
    connectorKey: string;
    name: string;
    encryptedPayload: Buffer;
    /** Omit only for a legacy write; new code passes ENC_VERSION_ENVELOPE. */
    encVersion?: number;
  },
): Promise<ConnectionRow> {
  const r = await db.query(
    `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0)) RETURNING *`,
    [args.workspaceId, args.connectorKey, args.name, args.encryptedPayload, args.encVersion ?? null],
  );
  return mapConnection(r.rows[0] as Record<string, unknown>);
}

export async function getConnectionWithPayload(
  db: Db,
  id: string,
  workspaceId?: string,
): Promise<(ConnectionRow & { workspaceId: string; encryptedPayload: Buffer; encVersion: number }) | null> {
  const r = workspaceId
    ? await db.query(`SELECT * FROM connections WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
    : await db.query(`SELECT * FROM connections WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    ...mapConnection(row),
    workspaceId: row['workspace_id'] as string,
    encryptedPayload: row['encrypted_payload'] as Buffer,
    encVersion: row['enc_version'] as number,
  };
}
```

- [ ] **Step 4: Widen `packages/db/src/repos/triggers.ts`**

Add two fields to `TriggerRow` (after `workflowId`, and after `secretEncrypted`):

```ts
export interface TriggerRow {
  id: string;
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  type: 'webhook' | 'schedule';
  routeKey: string;
  authMode: string | null;
  idempotencyKeyPath: string | null;
  cron: string | null;
  timezone: string | null;
  nextFireAt: string | null;
  active: boolean;
  secretEncrypted: Buffer | null;
  secretEncVersion: number;
}
```

In `mapTrigger`, add the two mappings. Because every read in this file uses `SELECT *`, this single change covers `upsertTrigger`, `getTriggerByRouteKey`, `listTriggers` and `dueScheduleTriggers` at once:

```ts
    workspaceId: r['workspace_id'] as string,
```

immediately after `id`, and

```ts
    secretEncVersion: (r['secret_enc_version'] as number | null) ?? 0,
```

immediately after `secretEncrypted`.

Then extend `upsertTrigger`'s args with `secretEncVersion?: number;`, add the column to the insert, and keep the blob and its version in lockstep on conflict:

```ts
  const r = await db.query(
    `INSERT INTO workflow_triggers
       (workspace_id, workflow_id, node_id, type, route_key, auth_mode, secret_encrypted, secret_enc_version,
        idempotency_key_path, cron, timezone, next_fire_at)
     SELECT w.workspace_id, w.id, $2, $3, $4, $5, $6, COALESCE($11, 0), $7, $8, $9, $10
       FROM workflows w WHERE w.id = $1
     ON CONFLICT (workflow_id, node_id) DO UPDATE SET
       type = EXCLUDED.type,
       auth_mode = EXCLUDED.auth_mode,
       secret_encrypted = COALESCE(workflow_triggers.secret_encrypted, EXCLUDED.secret_encrypted),
       -- Must move with the blob above, not independently: relabelling a retained v1
       -- secret as v0 would make it permanently unreadable.
       secret_enc_version = CASE
         WHEN workflow_triggers.secret_encrypted IS NULL THEN EXCLUDED.secret_enc_version
         ELSE workflow_triggers.secret_enc_version
       END,
       idempotency_key_path = EXCLUDED.idempotency_key_path,
       cron = EXCLUDED.cron,
       timezone = EXCLUDED.timezone,
       next_fire_at = EXCLUDED.next_fire_at,
       updated_at = now()
     RETURNING *`,
    [
      args.workflowId,
      args.nodeId,
      args.type,
      routeKey,
      args.authMode ?? null,
      args.secretEncrypted ?? null,
      args.idempotencyKeyPath ?? null,
      args.cron ?? null,
      args.timezone ?? null,
      args.nextFireAt ?? null,
      args.secretEncVersion ?? null,
    ],
  );
```

- [ ] **Step 5: Widen `packages/db/src/repos/workflows.ts`**

Replace `getWorkflowCallback` (line 150) and add the version to `setWorkflowCallback`:

```ts
export async function getWorkflowCallback(
  db: Db,
  workflowId: string,
): Promise<{ workspaceId: string; url: string; secretEncrypted: Buffer; encVersion: number } | null> {
  const r = await db.query(
    `SELECT workspace_id, completion_webhook_url, completion_webhook_secret_encrypted,
            completion_webhook_enc_version
       FROM workflows WHERE id = $1`,
    [workflowId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as {
    workspace_id: string;
    completion_webhook_url: string | null;
    completion_webhook_secret_encrypted: Buffer | null;
    completion_webhook_enc_version: number;
  };
  if (!row.completion_webhook_url || !row.completion_webhook_secret_encrypted) return null;
  return {
    workspaceId: row.workspace_id,
    url: row.completion_webhook_url,
    secretEncrypted: row.completion_webhook_secret_encrypted,
    encVersion: row.completion_webhook_enc_version,
  };
}
```

In `setWorkflowCallback`, add `encVersion?: number` to the args and write `completion_webhook_enc_version = COALESCE($N, 0)` alongside the secret, using the next free positional parameter.

- [ ] **Step 6: Widen `packages/db/src/repos/alerts.ts`**

Add `webhookSecretEncVersion?: number;` to `createAlertRule`'s args, add `webhook_secret_enc_version` to the insert column list with `COALESCE($8, 0)`, and pass `args.webhookSecretEncVersion ?? null` as the eighth parameter (shifting `cooldown_minutes` to `$9`). Then replace `getAlertWebhook` (line 210):

```ts
export async function getAlertWebhook(
  db: Db,
  ruleId: string,
): Promise<{ workspaceId: string; url: string; secretEncrypted: Buffer; encVersion: number } | null> {
  const r = await db.query(
    `SELECT workspace_id, webhook_url, webhook_secret_encrypted, webhook_secret_enc_version
       FROM alert_rules
      WHERE id=$1 AND webhook_url IS NOT NULL AND webhook_secret_encrypted IS NOT NULL`,
    [ruleId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as {
    workspace_id: string;
    webhook_url: string;
    webhook_secret_encrypted: Buffer;
    webhook_secret_enc_version: number;
  };
  return {
    workspaceId: row.workspace_id,
    url: row.webhook_url,
    secretEncrypted: row.webhook_secret_encrypted,
    encVersion: row.webhook_secret_enc_version,
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck
```

Expected: PASS, including the pre-existing repo tests — nothing was made required.

- [ ] **Step 8: Confirm the dependent apps still compile**

```bash
pnpm --filter @xperiment/api typecheck && pnpm --filter @xperiment/gateway typecheck && pnpm --filter @xperiment/worker typecheck && pnpm --filter @xperiment/scheduler typecheck
```

Expected: PASS. If `getWorkflowCallback` or `getAlertWebhook` consumers break, they are destructuring — add the new fields rather than reverting the widening.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/repos packages/db/test
git commit -m "feat: carry the workspace and encryption version through the secret repos"
```

---

### Task 8: API wiring — vaults, api-key identity, `audit:read`, `GET /v1/audit`

**Files:**
- Modify: `packages/db/src/repos/auth.ts:225-233`
- Modify: `apps/api/src/routes/deps.ts:11-27`
- Modify: `apps/api/src/server.ts:76-95`
- Modify: `apps/api/src/auth/plugin.ts:7-11,69-74`
- Modify: `apps/api/src/auth/permissions.ts`
- Create: `apps/api/src/routes/audit.ts`
- Test: `apps/api/test/audit.test.ts`, `apps/api/test/rbac.test.ts`

**Interfaces:**
- Consumes: `createKeyProviderFromEnv`, `createWorkspaceKeyring`, `createSecretVault`, `deriveLegacyKey`, `listAuditEvents`, `appendAuditEvent`.
- Produces: `ResolvedServerDeps.credentialsVault: SecretVault` and `.triggerVault: SecretVault` (alongside the still-present `triggerKey`/`credentialsKey`); `AuthContext.apiKeyId: string | null`; `Permission` gains `'audit:read'`; `registerAuditRoutes(app, deps)`; `auditActor(req)` helper.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/audit.test.ts`. Follow the existing harness in `apps/api/test/rbac.test.ts` for building the server and minting tokens — reuse its helpers verbatim rather than inventing a second pattern.

```ts
import { appendAuditEvent, createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let pool: Pool;
let ownerToken: string;
let viewerToken: string;
let workspaceId: string;
let otherWorkspaceId: string;

// seedWorkspaceWithRoles is the helper already used by rbac.test.ts; it returns
// { workspaceId, tokens } for a workspace with one member per role.
beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /v1/audit', () => {
  beforeEach(async () => {
    await pool.query(`TRUNCATE audit_events CASCADE`);
  });

  test('an owner reads their workspace’s events, newest first', async () => {
    await appendAuditEvent(pool, {
      workspaceId,
      actorKind: 'system',
      action: 'credential.read_use',
      targetType: 'connection',
      targetId: 'c-1',
    });
    await appendAuditEvent(pool, {
      workspaceId,
      actorKind: 'system',
      action: 'credential.create',
      targetType: 'connection',
      targetId: 'c-2',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { action: string; targetId: string }[]; nextBefore: string | null };
    expect(body.items.map((i) => i.targetId)).toEqual(['c-2', 'c-1']);
    expect(body.nextBefore).toBeNull(); // fewer rows than the page size
  });

  test('a viewer is refused', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toContain('audit:read');
  });

  test('another workspace’s events are invisible', async () => {
    await appendAuditEvent(pool, { workspaceId: otherWorkspaceId, actorKind: 'system', action: 'credential.create' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((res.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  test('a global event is never returned', async () => {
    await appendAuditEvent(pool, { actorKind: 'anonymous', action: 'auth.login_failed', outcome: 'failure' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((res.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  test('nextBefore drives the next page and the pages do not overlap', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendAuditEvent(pool, {
        workspaceId,
        actorKind: 'system',
        action: 'credential.read_use',
        targetId: `c-${i}`,
      });
    }
    const first = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=2',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const page1 = first.json() as { items: { targetId: string }[]; nextBefore: string | null };
    expect(page1.items.map((i) => i.targetId)).toEqual(['c-4', 'c-3']);
    expect(page1.nextBefore).not.toBeNull();
    const second = await app.inject({
      method: 'GET',
      url: `/v1/audit?limit=2&before=${page1.nextBefore}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((second.json() as { items: { targetId: string }[] }).items.map((i) => i.targetId)).toEqual(['c-2', 'c-1']);
  });

  test('a non-numeric cursor is a 400, not a 500', async () => {
    // No Fastify setErrorHandler exists in this app, so an unguarded value reaching a
    // bigint parameter surfaces the raw pg driver message as a 500.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit?before=abc',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  test('an out-of-range limit is a 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=0',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/audit.test.ts
```

Expected: FAIL — 404 on `/v1/audit`.

- [ ] **Step 3: Return the api-key id from the repo**

In `packages/db/src/repos/auth.ts`, replace `getActiveApiKey`:

```ts
export async function getActiveApiKey(
  db: Db,
  keyHash: string,
): Promise<{ id: string; workspaceId: string; role: Role } | null> {
  const r = await db.query(
    `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, workspace_id, role`,
    [keyHash],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { id: string; workspace_id: string; role: Role };
  return { id: row.id, workspaceId: row.workspace_id, role: row.role };
}
```

- [ ] **Step 4: Carry the api-key id in `AuthContext`**

In `apps/api/src/auth/plugin.ts`, widen the interface and populate it. An audit row must be able to name an api key as the actor, and today the context forgets which key authenticated:

```ts
export interface AuthContext {
  userId: string | null;
  apiKeyId: string | null;
  workspaceId: string;
  role: Role;
}
```

Set `apiKeyId: null` in both session branches (lines 59 and 65), and in the api-key branch (line 72):

```ts
      req.authContext = { userId: null, apiKeyId: key.id, workspaceId: key.workspaceId, role: key.role };
```

Then add the actor helper at the end of the file:

```ts
/**
 * The audit actor for the current request. Kept here so no route re-derives it and
 * gets the user/api-key distinction subtly wrong.
 */
export function auditActor(req: FastifyRequest): {
  actorKind: 'user' | 'api_key';
  actorUserId: string | null;
  actorApiKeyId: string | null;
  requestId: string;
  ip: string;
  userAgent: string | null;
} {
  const ctx = authOf(req);
  return {
    actorKind: ctx.apiKeyId ? 'api_key' : 'user',
    actorUserId: ctx.userId,
    actorApiKeyId: ctx.apiKeyId,
    requestId: req.id,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}
```

Fix any other construction of an `AuthContext` literal that the compiler now rejects — the api test helpers build them directly.

- [ ] **Step 5: Add the permission**

In `apps/api/src/auth/permissions.ts`, add `| 'audit:read'` to the `Permission` union, then:

```ts
const ADMIN: Permission[] = [...BUILDER, ...BILLING, 'member:manage', 'audit:read'];
```

and add `'audit:read'` to `ALL_PERMISSIONS` after `'member:manage'`. `ROLE_PERMISSIONS` needs no other change: `admin` and `owner` both spread `ADMIN`, and no other role does.

- [ ] **Step 6: Build the vaults in `ResolvedServerDeps`**

In `apps/api/src/routes/deps.ts`, add two fields after `credentialsKey` (leave the existing two in place — Task 14 removes them):

```ts
  /** Envelope encryption for connection payloads. Replaces credentialsKey. */
  credentialsVault: import('@xperiment/db').SecretVault;
  /** Envelope encryption for trigger, callback and alert webhook secrets. */
  triggerVault: import('@xperiment/db').SecretVault;
```

In `apps/api/src/server.ts`, add to `ServerDeps` the optional overrides `keyProvider?: KeyProvider`, `credentialsVault?: SecretVault`, `triggerVault?: SecretVault`, and build them in `resolvedDeps`:

```ts
  const keyProvider = deps.keyProvider ?? localKeyProvider(process.env['KEK_MASTER_KEY'] ?? 'xperiment-dev-kek-master-change-me');
  const keyring = createWorkspaceKeyring({
    pool: deps.pool,
    provider: keyProvider,
    ...(process.env['KEK_CACHE_TTL_MS'] ? { ttlMs: Number(process.env['KEK_CACHE_TTL_MS']) } : {}),
  });
```

then inside `resolvedDeps`:

```ts
    credentialsVault:
      deps.credentialsVault ??
      createSecretVault({
        keyring,
        legacyKey: deriveLegacyKey(process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me'),
      }),
    triggerVault:
      deps.triggerVault ??
      createSecretVault({
        keyring,
        legacyKey: deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
      }),
```

`buildServer` is synchronous and used that way by every test, so it uses `localKeyProvider` directly rather than the async `createKeyProviderFromEnv`. The async factory belongs in the long-running entrypoints (`apps/api/src/main.ts`, gateway, worker), which already use top-level await; those pass the result in as `deps.keyProvider`. Wire `apps/api/src/main.ts` to do so:

```ts
const keyProvider = await createKeyProviderFromEnv();
const app = buildServer({ pool, keyProvider });
```

- [ ] **Step 7: Implement `apps/api/src/routes/audit.ts`**

```ts
import { listAuditEvents } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

/**
 * Strict rather than lenient. There is no Fastify error handler in this app, so an
 * unvalidated `before` reaching a ::bigint parameter would surface the pg driver's
 * message as a 500. A digits-only cursor keeps it a 400.
 */
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().regex(/^\d+$/).optional(),
    action: z.string().min(1).max(120).optional(),
    targetType: z.string().min(1).max(60).optional(),
    targetId: z.string().min(1).max(200).optional(),
  })
  .strict();

export function registerAuditRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/audit', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'audit:read')) return;
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid query', parsed.error.message);
    const { limit, before, action, targetType, targetId } = parsed.data;
    const items = await listAuditEvents(deps.pool, {
      workspaceId: ctx.workspaceId,
      limit,
      ...(before ? { before } : {}),
      ...(action ? { action } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
    });
    // A full page means there may be more; a short page is the end.
    const nextBefore = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    return { items, nextBefore };
  });
}
```

Register it in `apps/api/src/server.ts` beside the other `register*Routes(app, resolvedDeps)` calls.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
pnpm --filter @xperiment/api exec vitest run test/audit.test.ts test/rbac.test.ts
```

Expected: PASS. The RBAC matrix test asserts every entry in `ALL_PERMISSIONS` is routed, so it fails if the route registration was forgotten — that is the intended coupling.

- [ ] **Step 9: Full api suite, typecheck, commit**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck && pnpm --filter @xperiment/db typecheck
git add packages/db/src/repos/auth.ts apps/api/src
git add apps/api/test/audit.test.ts
git commit -m "feat: wire the secret vaults and add the audit read endpoint"
```

---

### Task 9: Connection routes — vault, transaction, three audit actions

**Files:**
- Modify: `apps/api/src/routes/connections.ts`
- Test: `apps/api/test/connections.test.ts`

**Interfaces:**
- Consumes: `deps.credentialsVault`, `appendAuditEvent`, `auditActor`, `withTx`, `createConnection`, `deleteConnection`, `getConnectionWithPayload`.
- Produces: no new exports. Actions written: `credential.create`, `credential.delete`, `credential.test`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/connections.test.ts` (reuse the file's existing server/token harness):

```ts
  test('a created connection is stored at the envelope version', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections',
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { connectorKey: 'telegram', name: 'Bot', payload: { botToken: 'tok-secret-123' } },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const row = await pool.query<{ enc_version: number; encrypted_payload: Buffer }>(
      `SELECT enc_version, encrypted_payload FROM connections WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]!.enc_version).toBe(1);
    expect(row.rows[0]!.encrypted_payload.toString('utf8')).not.toContain('tok-secret-123');
  });

  test('creating a connection writes exactly one credential.create audit row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections',
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { connectorKey: 'telegram', name: 'Audited', payload: { botToken: 'tok-xyz' } },
    });
    const id = (res.json() as { id: string }).id;
    const audit = await pool.query<{ action: string; target_id: string; metadata: Record<string, unknown> }>(
      `SELECT action, target_id, metadata FROM audit_events WHERE workspace_id = $1 AND action = 'credential.create'`,
      [workspaceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.target_id).toBe(id);
    expect(audit.rows[0]!.metadata).toMatchObject({ connectorKey: 'telegram' });
    // The secret must never reach the audit row.
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain('tok-xyz');
  });

  test('a rejected create writes no audit row', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/connections',
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { connectorKey: 'telegram', name: 'Bad', payload: {} },
    });
    const audit = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'credential.create'`,
    );
    expect(audit.rows[0]!.c).toBe('0');
  });

  test('deleting a connection audits it, and a 404 delete does not', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/connections',
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { connectorKey: 'telegram', name: 'Doomed', payload: { botToken: 't' } },
    });
    const id = (created.json() as { id: string }).id;
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/connections/${id}`,
          headers: { authorization: `Bearer ${builderToken}` },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/connections/${id}`,
          headers: { authorization: `Bearer ${builderToken}` },
        })
      ).statusCode,
    ).toBe(404);
    const audit = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'credential.delete' AND target_id = $1`,
      [id],
    );
    expect(audit.rows[0]!.c).toBe('1');
  });

  test('an api-key caller is recorded as the api_key actor, not as a user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections',
      headers: { authorization: `Bearer ${builderApiKey}` },
      payload: { connectorKey: 'telegram', name: 'ByKey', payload: { botToken: 't' } },
    });
    expect(res.statusCode).toBe(201);
    const audit = await pool.query<{ actor_kind: string; actor_api_key_id: string | null; actor_user_id: string | null }>(
      `SELECT actor_kind, actor_api_key_id, actor_user_id FROM audit_events
        WHERE action = 'credential.create' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]!.actor_kind).toBe('api_key');
    expect(audit.rows[0]!.actor_api_key_id).not.toBeNull();
    expect(audit.rows[0]!.actor_user_id).toBeNull();
  });
```

`builderApiKey` is a `qk_`-prefixed token for a builder-role api key; mint it with the same helper `rbac.test.ts` uses.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/connections.test.ts
```

Expected: FAIL — `enc_version` is 0 and no audit rows exist.

- [ ] **Step 3: Rewrite `apps/api/src/routes/connections.ts`**

```ts
import { CONNECTION_PAYLOAD_SCHEMAS, type ConnectorKey } from '@xperiment/connectors';
import {
  appendAuditEvent,
  countPublishedRefs,
  createConnection,
  deleteConnection,
  getConnectionWithPayload,
  listConnections,
  withTx,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const createSchema = z
  .object({
    connectorKey: z.string().min(1),
    name: z.string().min(1).max(200),
    payload: z.unknown(),
  })
  .strict();

export function registerConnectionRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/connections', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'connection:write')) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const schema = CONNECTION_PAYLOAD_SCHEMAS[parsed.data.connectorKey as ConnectorKey];
    if (!schema) return sendProblem(reply, 400, 'Unknown connector key');
    const payload = schema.safeParse(parsed.data.payload);
    if (!payload.success) return sendProblem(reply, 400, 'Invalid connection payload', payload.error.message);

    const sealed = await deps.credentialsVault.encrypt(ctx.workspaceId, JSON.stringify(payload.data));
    // One transaction: the audit row must not survive a failed insert, and must not
    // be lost when the insert commits.
    const row = await withTx(deps.pool, async (client) => {
      const created = await createConnection(client, {
        workspaceId: ctx.workspaceId,
        connectorKey: parsed.data.connectorKey,
        name: parsed.data.name,
        encryptedPayload: sealed.blob,
        encVersion: sealed.encVersion,
      });
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'credential.create',
        targetType: 'connection',
        targetId: created.id,
        // Named scalars only — never the payload.
        metadata: { connectorKey: created.connectorKey, name: created.name },
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.get('/v1/connections', async (req, reply) => {
    // SEC-004: credential metadata is shared by role — viewers/operators/billing cannot list.
    if (!requirePermission(reply, authOf(req), 'connection:read')) return;
    return { items: await listConnections(deps.pool, authOf(req).workspaceId) };
  });

  app.delete('/v1/connections/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'connection:write')) return;
    const { id } = req.params as { id: string };
    const refs = await countPublishedRefs(deps.pool, id);
    if (refs > 0) {
      return sendProblem(reply, 409, 'Connection in use', `Referenced by ${refs} published workflow version(s)`);
    }
    const deleted = await withTx(deps.pool, async (client) => {
      const ok = await deleteConnection(client, id, ctx.workspaceId);
      if (!ok) return false;
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'credential.delete',
        targetType: 'connection',
        targetId: id,
      });
      return true;
    });
    if (!deleted) return sendProblem(reply, 404, 'Connection not found');
    return reply.status(204).send();
  });

  app.post('/v1/connections/:id/test', async (req, reply) => {
    // Testing dials a third party with the stored credential — a write-shaped action.
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'connection:write')) return;
    const { id } = req.params as { id: string };
    const row = await getConnectionWithPayload(deps.pool, id, ctx.workspaceId);
    if (!row) return sendProblem(reply, 404, 'Connection not found');
    const def = deps.registry
      .list()
      .find((d) => d.requiresConnection === row.connectorKey && d.testConnection !== undefined);
    if (!def?.testConnection) return sendProblem(reply, 400, 'Connector does not support test');
    let outcome: 'success' | 'failure' = 'success';
    try {
      const payload: unknown = JSON.parse(
        await deps.credentialsVault.decrypt(ctx.workspaceId, {
          blob: row.encryptedPayload,
          encVersion: row.encVersion,
        }),
      );
      await def.testConnection(payload, AbortSignal.timeout(10000));
    } catch {
      outcome = 'failure';
    }
    // A human decrypting a credential on demand is an auditable read, whether or not
    // the third party accepted it. Emitted on the pool: nothing was mutated.
    await appendAuditEvent(deps.pool, {
      ...auditActor(req),
      workspaceId: ctx.workspaceId,
      action: 'credential.test',
      targetType: 'connection',
      targetId: id,
      outcome,
      metadata: { connectorKey: row.connectorKey },
    });
    // Never surface provider/internal error text — it may embed credentials.
    return outcome === 'success' ? { ok: true } : { ok: false, error: 'connection test failed' };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/api exec vitest run test/connections.test.ts
```

Expected: PASS.

- [ ] **Step 5: Confirm the transaction actually guards the audit row**

Temporarily make `createConnection` throw after inserting, by adding `throw new Error('x')` immediately after the `createConnection` call inside `withTx`. Run:

```bash
pnpm --filter @xperiment/api exec vitest run test/connections.test.ts -t "a rejected create writes no audit row"
```

Then move the `appendAuditEvent` call outside the `withTx` block (onto `deps.pool`) with the throw still in place and re-run: the count must become 1, proving the test discriminates. Restore both.

- [ ] **Step 6: Full api suite and commit**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/connections.ts apps/api/test/connections.test.ts
git commit -m "feat: encrypt connection payloads per workspace and audit their use"
```

---

### Task 10: Trigger, callback and alert routes

**Files:**
- Modify: `apps/api/src/routes/triggers.ts:33-49,76-80`
- Modify: `apps/api/src/routes/workflows.ts:136-144`
- Modify: `apps/api/src/routes/alerts.ts:46-53`
- Test: `apps/api/test/triggers.test.ts`, `apps/api/test/callback.test.ts`, `apps/api/test/alerts.test.ts`

**Interfaces:**
- Consumes: `deps.triggerVault`, `appendAuditEvent`, `auditActor`.
- Produces: no new exports. Action written: `trigger_secret.reveal`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/triggers.test.ts`:

```ts
  test('an activated webhook trigger stores its secret at the envelope version', async () => {
    // activateWebhookWorkflow is the existing helper that publishes and activates a
    // workflow containing one webhook.trigger node.
    const { workflowId } = await activateWebhookWorkflow();
    const row = await pool.query<{ secret_enc_version: number }>(
      `SELECT secret_enc_version FROM workflow_triggers WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(row.rows[0]!.secret_enc_version).toBe(1);
  });

  test('listing triggers with credentials reveals the secret and audits the reveal', async () => {
    const { workflowId } = await activateWebhookWorkflow();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workflows/${workflowId}/triggers`,
      headers: { authorization: `Bearer ${builderToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: { nodeId: string; secret?: string | null }[] }).items;
    expect(typeof items[0]!.secret).toBe('string');
    const audit = await pool.query<{ action: string; target_id: string; metadata: Record<string, unknown> }>(
      `SELECT action, target_id, metadata FROM audit_events WHERE action = 'trigger_secret.reveal'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.target_id).toBe(items[0]!.nodeId);
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain(items[0]!.secret!);
  });

  test('a reader gets no secret and no reveal is audited', async () => {
    const { workflowId } = await activateWebhookWorkflow();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workflows/${workflowId}/triggers`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: Record<string, unknown>[] }).items[0]).not.toHaveProperty('secret');
    const audit = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'trigger_secret.reveal'`,
    );
    expect(audit.rows[0]!.c).toBe('0');
  });
```

Append to `apps/api/test/callback.test.ts`:

```ts
  test('a callback secret is stored at the envelope version and round-trips', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${workflowId}/callback`,
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { url: 'https://example.com/hook' },
    });
    expect(res.statusCode).toBe(200);
    const secret = (res.json() as { secret: string }).secret;
    const row = await pool.query<{ completion_webhook_enc_version: number }>(
      `SELECT completion_webhook_enc_version FROM workflows WHERE id = $1`,
      [workflowId],
    );
    expect(row.rows[0]!.completion_webhook_enc_version).toBe(1);
    expect(secret.length).toBeGreaterThan(20);
  });
```

Append to `apps/api/test/alerts.test.ts`:

```ts
  test('an alert webhook secret is stored at the envelope version', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/alerts',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        type: 'failure_rate',
        name: 'Spike',
        params: { thresholdPercent: 50, windowMinutes: 15, minExecutions: 5 },
        webhookUrl: 'https://example.com/alert',
      },
    });
    expect(res.statusCode).toBe(201);
    const row = await pool.query<{ webhook_secret_enc_version: number }>(
      `SELECT webhook_secret_enc_version FROM alert_rules WHERE id = $1`,
      [(res.json() as { id: string }).id],
    );
    expect(row.rows[0]!.webhook_secret_enc_version).toBe(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @xperiment/api exec vitest run test/triggers.test.ts test/callback.test.ts test/alerts.test.ts
```

Expected: FAIL — every version column reads 0 and no reveal is audited.

- [ ] **Step 3: Make `triggerView` async and audit the reveal**

In `apps/api/src/routes/triggers.ts`, replace the `triggerView` function and its call site.

```ts
async function triggerView(
  t: TriggerRow,
  gatewayUrl: string,
  vault: SecretVault,
  includeCredentials: boolean,
): Promise<Record<string, unknown>> {
  const base = { nodeId: t.nodeId, type: t.type, active: t.active };
  if (t.type === 'webhook') {
    return {
      ...base,
      authMode: t.authMode,
      ...(includeCredentials
        ? {
            url: `${gatewayUrl}/t/${t.routeKey}`,
            testUrl: `${gatewayUrl}/t/test/${t.routeKey}`,
            secret: t.secretEncrypted
              ? await vault.decrypt(t.workspaceId, { blob: t.secretEncrypted, encVersion: t.secretEncVersion })
              : null,
          }
        : {}),
    };
  }
  return { ...base, cron: t.cron, timezone: t.timezone, nextFireAt: t.nextFireAt };
}
```

Import `type SecretVault` from `@xperiment/db`. In the `GET /v1/workflows/:id/triggers` handler, replace the `.map(...)` with:

```ts
    const includeCredentials = hasPermission(ctx.role, 'workflow:activate');
    const items = await Promise.all(
      triggers.map((t) => triggerView(t, deps.gatewayUrl, deps.triggerVault, includeCredentials)),
    );
    if (includeCredentials) {
      // Handing out a plaintext signing secret is the one read on this surface that
      // transfers a capability, so it is audited per trigger.
      for (const t of triggers.filter((x) => x.type === 'webhook' && x.secretEncrypted)) {
        await appendAuditEvent(deps.pool, {
          ...auditActor(req),
          workspaceId: ctx.workspaceId,
          action: 'trigger_secret.reveal',
          targetType: 'trigger',
          targetId: t.nodeId,
          metadata: { workflowId: t.workflowId, authMode: t.authMode ?? 'none' },
        });
      }
    }
    return { items };
```

Keep the existing variable names for `ctx` and `triggers` as they already appear in the handler; add imports for `appendAuditEvent`, `auditActor` and `hasPermission` if the handler previously computed `includeCredentials` inline.

- [ ] **Step 4: Encrypt the activation secret through the vault**

Still in `apps/api/src/routes/triggers.ts`, the activate handler is already `async`. Hoist the secret out of the object literal because it now needs an `await`:

```ts
      if (node.type === 'webhook.trigger') {
        const p = node.parameters as { authMode: string; idempotencyKeyPath?: string };
        const sealed =
          p.authMode === 'none'
            ? null
            : await deps.triggerVault.encrypt(ctx.workspaceId, randomBytes(24).toString('base64url'));
        await upsertTrigger(deps.pool, {
          workflowId: id,
          nodeId: node.id,
          type: 'webhook',
          authMode: p.authMode,
          ...(p.idempotencyKeyPath ? { idempotencyKeyPath: p.idempotencyKeyPath } : {}),
          secretEncrypted: sealed?.blob ?? null,
          ...(sealed ? { secretEncVersion: sealed.encVersion } : {}),
        });
      }
```

- [ ] **Step 5: Encrypt the callback secret**

In `apps/api/src/routes/workflows.ts`, replace the body of the `PUT /v1/workflows/:id/callback` handler's write:

```ts
    const secret = randomBytes(24).toString('base64url');
    const sealed = await deps.triggerVault.encrypt(ctx.workspaceId, secret);
    await setWorkflowCallback(deps.pool, {
      workflowId: id,
      url: parsed.data.url,
      secretEncrypted: sealed.blob,
      encVersion: sealed.encVersion,
    });
    // The signing secret is shown once, like a trigger secret.
    return { url: parsed.data.url, secret };
```

- [ ] **Step 6: Encrypt the alert webhook secret**

In `apps/api/src/routes/alerts.ts`, replace the secret block in `POST /v1/alerts`:

```ts
    let secret: string | undefined;
    let sealed: { blob: Buffer; encVersion: number } | undefined;
    if (d.webhookUrl) {
      secret = randomBytes(24).toString('base64url');
      sealed = await deps.triggerVault.encrypt(ctx.workspaceId, secret);
    }
    const rule = await createAlertRule(deps.pool, {
      workspaceId: ctx.workspaceId,
      name: d.name,
      type: d.type,
      params: d.params,
      ...(d.webhookUrl ? { webhookUrl: d.webhookUrl } : {}),
      ...(sealed ? { webhookSecretEncrypted: sealed.blob, webhookSecretEncVersion: sealed.encVersion } : {}),
      ...(d.cooldownMinutes ? { cooldownMinutes: d.cooldownMinutes } : {}),
    });
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck
```

Expected: PASS. The gateway and worker still read these secrets with the legacy key, which no longer matches — their tests will fail once they exercise a v1 blob. That is Task 12; the api suite and the gateway/worker suites are independent, so nothing is broken in between.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/triggers.ts apps/api/src/routes/workflows.ts apps/api/src/routes/alerts.ts apps/api/test
git commit -m "feat: move trigger, callback and alert secrets onto the workspace vault"
```

---

### Task 11: Port the five auth events onto `audit_events`

**Files:**
- Modify: `apps/api/src/routes/auth.ts:42,60,66,75,83`
- Test: `apps/api/test/auth.test.ts`
- Test: `packages/db/test/auth.test.ts:139`

**Interfaces:**
- Consumes: `appendAuditEvent`.
- Produces: nothing. Actions written: `auth.register`, `auth.login_failed`, `auth.login_succeeded`, `auth.logout`, `auth.logout_all`. `appendAuthEvent` is deleted.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/auth.test.ts`, the existing assertion at line 63 counts `auth_events` rows for a failed login. Change it to read the new table, and add coverage for the actor split:

```ts
    const audited = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit_events
        WHERE actor_label = $1 AND action = 'auth.login_failed' AND outcome = 'failure'`,
      [email],
    );
    expect(audited.rows[0]!.c).toBe(1);
```

Add:

```ts
  test('a failed login for an unknown email is global, not attributed to a workspace', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ghost@example.com', password: 'whatever-123' },
    });
    const row = await pool.query<{ workspace_id: string | null; actor_kind: string; actor_user_id: string | null }>(
      `SELECT workspace_id, actor_kind, actor_user_id FROM audit_events WHERE actor_label = 'ghost@example.com'`,
    );
    expect(row.rows[0]).toMatchObject({ workspace_id: null, actor_kind: 'anonymous', actor_user_id: null });
  });

  test('a successful login is attributed to the user and records no password material', async () => {
    // registerAndLogin is the existing helper returning { email, password, userId }.
    const { email, password, userId } = await registerAndLogin();
    const row = await pool.query<{ actor_kind: string; actor_user_id: string; metadata: unknown }>(
      `SELECT actor_kind, actor_user_id, metadata FROM audit_events
        WHERE action = 'auth.login_succeeded' AND actor_label = $1`,
      [email],
    );
    expect(row.rows[0]).toMatchObject({ actor_kind: 'user', actor_user_id: userId });
    expect(JSON.stringify(row.rows[0]!.metadata)).not.toContain(password);
  });

  test('auth_events receives no new writes', async () => {
    const before = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM auth_events`);
    await registerAndLogin();
    const after = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM auth_events`);
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });
```

In `packages/db/test/auth.test.ts`, delete the `appendAuthEvent` test at line 139 and remove `auth_events` from the `TRUNCATE` at line 37 — the repo no longer writes there, and the table is now historical data that must not be wiped by a test.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @xperiment/api exec vitest run test/auth.test.ts
```

Expected: FAIL — zero rows in `audit_events`.

- [ ] **Step 3: Delete `appendAuthEvent`**

Remove the function from `packages/db/src/repos/auth.ts` (lines 317–328). Nothing else in the repo calls it after Step 4.

- [ ] **Step 4: Rewrite the five call sites in `apps/api/src/routes/auth.ts`**

These routes are outside the auth plugin (`/v1/auth/register` and `/v1/auth/login` are in `EXEMPT`), so `auditActor(req)` is unavailable — there is no `authContext`. Build the actor inline. Emit on the pool: register creates a user in its own repo call, and treating the audit row as part of that would require restructuring `registerUser`, which is out of scope for P.

Replace line 42:

```ts
    await appendAuditEvent(deps.pool, {
      actorKind: 'user',
      actorUserId: user.id,
      actorLabel: user.email,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
```

Replace line 60:

```ts
      await appendAuditEvent(deps.pool, {
        actorKind: 'anonymous',
        actorLabel: parsed.data.email,
        action: 'auth.login_failed',
        outcome: 'failure',
        requestId: req.id,
        ip: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
```

Replace line 66:

```ts
    await appendAuditEvent(deps.pool, {
      actorKind: 'user',
      actorUserId: user.id,
      actorLabel: user.email,
      action: 'auth.login_succeeded',
      targetType: 'user',
      targetId: user.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
```

Replace line 75 (`logout`) and line 83 (`logout_all`) with the same shape, `action: 'auth.logout'` / `'auth.logout_all'`, `actorUserId: ctx.userId`, `targetType: 'user'`, `targetId: ctx.userId`. These two are behind the auth plugin, so use `...auditActor(req)` instead of building the actor by hand, and add `workspaceId: ctx.workspaceId` — a logout does belong to the workspace the session was acting in.

Update the import at the top of the file: `appendAuthEvent` out, `appendAuditEvent` in.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/db test
```

Expected: PASS.

- [ ] **Step 6: Confirm no writer remains**

```bash
cd "<repo-root>" && grep -rn "appendAuthEvent\|INSERT INTO auth_events" --include=*.ts . | grep -v node_modules
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
pnpm --filter @xperiment/api typecheck && pnpm --filter @xperiment/db typecheck
git add packages/db/src/repos/auth.ts packages/db/test/auth.test.ts apps/api/src/routes/auth.ts apps/api/test/auth.test.ts
git commit -m "feat: move authentication events onto the audit spine"
```

---

### Task 12: Gateway and worker — vaults, the workspace filter, read-use audit

**Files:**
- Modify: `apps/gateway/src/main.ts:1-11`
- Modify: `apps/gateway/src/server.ts:1-23,53`
- Modify: `apps/worker/src/main.ts:22-65`
- Modify: `apps/worker/src/runTask.ts:35-65,108`
- Modify: `apps/worker/src/callback.ts:3,41`
- Modify: `apps/worker/src/alertDelivery.ts:3,52`
- Test: `apps/gateway/test/gateway.test.ts`, `apps/worker/test/runTask.test.ts`, `apps/worker/test/connections.test.ts`, `apps/worker/test/callback.test.ts`, `apps/worker/test/alertDelivery.test.ts`

**Interfaces:**
- Consumes: `SecretVault`, `createWorkspaceKeyring`, `createKeyProviderFromEnv`, `createSecretVault`, `deriveLegacyKey`, `appendAuditEvent`, `getConnectionWithPayload`.
- Produces: `GatewayDeps.triggerVault: SecretVault` (replaces `triggerKey`); `WorkerDeps.credentialsVault: SecretVault` (replaces `credentialsKey`); `CallbackDeps.triggerVault` (replaces `triggerKey`); `AlertDeliveryDeps.triggerVault` (replaces `alertKey`). Action written: `credential.read_use`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/connections.test.ts`:

```ts
  test('a node resolves an envelope-encrypted connection and audits the read', async () => {
    // seedConnection is this file's existing helper; it now takes a vault.
    const connectionId = await seedConnection({ botToken: 'tok-live' });
    const { executionId, nodeId } = await seedExecutionUsing(connectionId);
    await runNodeTask(deps, { executionId, nodeId, attempt: 1 });
    const audit = await pool.query<{ action: string; actor_kind: string; metadata: Record<string, unknown> }>(
      `SELECT action, actor_kind, metadata FROM audit_events WHERE action = 'credential.read_use'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_kind).toBe('system');
    expect(audit.rows[0]!.metadata).toMatchObject({ executionId, nodeId });
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain('tok-live');
  });

  test('a connection belonging to another workspace is not resolved', async () => {
    // The defect this closes: runTask omitted the optional workspaceId, so a published
    // IR naming any connection UUID resolved it. Envelope encryption makes the
    // workspace mandatory, and this asserts the filter, not just the decryption.
    const foreignWorkspace = randomUUID();
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'other')`, [foreignWorkspace]);
    const foreignConnection = await seedConnection({ botToken: 'not-yours' }, foreignWorkspace);
    const { executionId, nodeId } = await seedExecutionUsing(foreignConnection);
    await runNodeTask(deps, { executionId, nodeId, attempt: 1 });
    const node = await pool.query<{ status: string; error_json: { code: string } | null }>(
      `SELECT status, error_json FROM execution_nodes WHERE execution_id = $1 AND node_id = $2`,
      [executionId, nodeId],
    );
    expect(node.rows[0]!.status).toBe('FAILED');
    expect(node.rows[0]!.error_json?.code).toBe('connection_not_found');
    const audit = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'credential.read_use'`,
    );
    expect(audit.rows[0]!.c).toBe('0');
  });
```

Append to `apps/gateway/test/gateway.test.ts`:

```ts
  test('a webhook authenticates against an envelope-encrypted secret', async () => {
    // seedWebhookTrigger writes the trigger row; give it the vault so the secret is v1.
    const { routeKey, secret } = await seedWebhookTrigger('token');
    const ok = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      payload: { hello: 'world' },
    });
    expect(ok.statusCode).toBe(202);
    const bad = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      payload: { hello: 'world' },
    });
    expect(bad.statusCode).toBe(401);
  });
```

Update `apps/worker/test/callback.test.ts` and `apps/worker/test/alertDelivery.test.ts` so their seeded secrets are written through a vault at `encVersion: 1` and the deps carry `triggerVault` instead of `triggerKey`/`alertKey`. Keep one test per file that seeds a **legacy** secret (`encVersion: 0`) and asserts delivery still signs correctly — that is the mixed-state guarantee the backfill depends on.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @xperiment/worker exec vitest run test/connections.test.ts && pnpm --filter @xperiment/gateway test
```

Expected: FAIL — `deps.credentialsVault` is undefined and no audit rows exist.

- [ ] **Step 3: Rewire the gateway**

In `apps/gateway/src/server.ts`, replace the deps interface and the decrypt:

```ts
export interface GatewayDeps {
  pool: pg.Pool;
  triggerVault: SecretVault;
}
```

Import `type SecretVault` from `@xperiment/db` and drop the `decryptSecret` import. Then at line 53:

```ts
        const secret = trigger.secretEncrypted
          ? await deps.triggerVault.decrypt(trigger.workspaceId, {
              blob: trigger.secretEncrypted,
              encVersion: trigger.secretEncVersion,
            })
          : '';
```

The handler is already `async`, and `trigger.workspaceId` exists because `mapTrigger` now selects it (Task 7).

In `apps/gateway/src/main.ts`:

```ts
import {
  createKeyProviderFromEnv,
  createPool,
  createSecretVault,
  createWorkspaceKeyring,
  deriveLegacyKey,
  runMigrations,
} from '@xperiment/db';
import { createQueues, createRedisConnection, startOutboxPublisher } from '@xperiment/queue';
import { buildGateway } from './server.js';

const pool = createPool();
await runMigrations(pool);

const keyring = createWorkspaceKeyring({
  pool,
  provider: await createKeyProviderFromEnv(),
  ...(process.env['KEK_CACHE_TTL_MS'] ? { ttlMs: Number(process.env['KEK_CACHE_TTL_MS']) } : {}),
});
const app = buildGateway({
  pool,
  triggerVault: createSecretVault({
    keyring,
    legacyKey: deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
  }),
});
```

Leave the rest of the file unchanged.

- [ ] **Step 4: Rewire the worker's connection resolution**

In `apps/worker/src/runTask.ts`, replace the deps interface and `resolveConnection`:

```ts
export interface WorkerDeps {
  pool: pg.Pool;
  registry: ConnectorRegistry;
  workerId: string;
  credentialsVault: SecretVault;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Resolves and decrypts the node's connection payload; throws NormalizedError-shaped info via recordFailure at the call site.
 *
 * The workspace id is required, not optional. Before envelope encryption this call
 * omitted it and would resolve any connection UUID in the database, so a published IR
 * could reach another tenant's credential — publish-time validation was the only
 * guard. Decryption now needs the workspace anyway, so the filter cannot be dropped.
 */
async function resolveConnection(
  deps: WorkerDeps,
  node: IRNode,
  ctx: { workspaceId: string; executionId: string; workflowId: string },
): Promise<{ ok: true; connection: unknown } | { ok: false; error: NormalizedError }> {
  const def = deps.registry.get(node.type);
  if (!def?.requiresConnection) return { ok: true, connection: undefined };
  if (!node.connectionRef) {
    return {
      ok: false,
      error: normalizedError('connection_required', `Node requires a '${def.requiresConnection}' connection`, false),
    };
  }
  const row = await getConnectionWithPayload(deps.pool, node.connectionRef, ctx.workspaceId);
  if (!row || row.connectorKey !== def.requiresConnection) {
    return { ok: false, error: normalizedError('connection_not_found', 'Referenced connection not found', false) };
  }
  try {
    const plaintext = await deps.credentialsVault.decrypt(ctx.workspaceId, {
      blob: row.encryptedPayload,
      encVersion: row.encVersion,
    });
    const connection: unknown = JSON.parse(plaintext);
    // SEC-009: one row per node that actually consumed a credential. Emitted on the
    // pool — nothing was mutated — with a system actor, since no user is present.
    await appendAuditEvent(deps.pool, {
      workspaceId: ctx.workspaceId,
      actorKind: 'system',
      action: 'credential.read_use',
      targetType: 'connection',
      targetId: row.id,
      metadata: {
        executionId: ctx.executionId,
        nodeId: node.id,
        workflowId: ctx.workflowId,
        connectorKey: row.connectorKey,
      },
    });
    return { ok: true, connection };
  } catch {
    return { ok: false, error: normalizedError('connection_invalid', 'Stored connection could not be decrypted', false) };
  }
}
```

Import `appendAuditEvent` and `type SecretVault` from `@xperiment/db`; drop `decryptSecret`.

At the call site (line 108), pass the context — `detail.execution` already carries `workspaceId` and `workflowVersionId`, and `detail.execution.workflowId` is the workflow:

```ts
    const connectionResult = await resolveConnection(deps, node, {
      workspaceId: detail.execution.workspaceId,
      executionId,
      workflowId: detail.execution.workflowId,
    });
```

A failed decrypt is deliberately **not** audited as a read-use: nothing was read. The node fails with `connection_invalid`, which is what a cold cache plus an unreachable KMS produces — fail closed, per spec §11.

- [ ] **Step 5: Rewire the worker's callback and alert delivery**

In `apps/worker/src/callback.ts`, replace `triggerKey: Buffer` in `CallbackDeps` with `triggerVault: SecretVault`, and line 41:

```ts
  const secret = await deps.triggerVault.decrypt(cb.workspaceId, {
    blob: cb.secretEncrypted,
    encVersion: cb.encVersion,
  });
```

In `apps/worker/src/alertDelivery.ts`, replace `alertKey: Buffer` in `AlertDeliveryDeps` with `triggerVault: SecretVault` — the name `alertKey` implied a third key family that never existed — and line 52:

```ts
  const secret = await deps.triggerVault.decrypt(cb.workspaceId, {
    blob: cb.secretEncrypted,
    encVersion: cb.encVersion,
  });
```

- [ ] **Step 6: Rewire `apps/worker/src/main.ts`**

Build one keyring and two vaults, then hand them to the three dep objects:

```ts
const keyring = createWorkspaceKeyring({
  pool,
  provider: await createKeyProviderFromEnv(),
  ...(process.env['KEK_CACHE_TTL_MS'] ? { ttlMs: Number(process.env['KEK_CACHE_TTL_MS']) } : {}),
});
const credentialsVault = createSecretVault({
  keyring,
  legacyKey: deriveLegacyKey(process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me'),
});
const triggerVault = createSecretVault({
  keyring,
  legacyKey: deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
});
```

Then `deps.credentialsVault = credentialsVault`, `callbackDeps.triggerVault = triggerVault`, `alertDeps.triggerVault = triggerVault`, removing the three `deriveLegacyKey(...)` inline calls at lines 26, 45 and 58. One keyring across all three means one KMS unwrap per workspace per TTL for the whole worker process, not three.

- [ ] **Step 7: Run every suite**

```bash
pnpm --filter @xperiment/gateway test && pnpm --filter @xperiment/worker test && pnpm --filter @xperiment/api test && pnpm --filter @xperiment/db test && pnpm --filter @xperiment/scheduler test
```

Expected: PASS.

- [ ] **Step 8: Prove the workspace filter is what the test catches**

Temporarily drop the third argument in `getConnectionWithPayload(deps.pool, node.connectionRef, ctx.workspaceId)` and re-run:

```bash
pnpm --filter @xperiment/worker exec vitest run test/connections.test.ts -t "another workspace"
```

Expected: FAIL — the lookup succeeds and the decrypt then fails with `connection_invalid` rather than `connection_not_found`, so the assertion on the error code is what discriminates. This is why the test asserts the code and not merely that the node failed. Restore the argument.

- [ ] **Step 9: Commit**

```bash
pnpm --filter @xperiment/worker typecheck && pnpm --filter @xperiment/gateway typecheck
git add apps/gateway apps/worker
git commit -m "feat: resolve worker and gateway secrets through the workspace vault"
```

---

### Task 13: Backfill and the `xperiment rekey` command

**Files:**
- Create: `packages/db/src/crypto/rekey.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/package.json`
- Test: `packages/db/test/rekey.test.ts`

**Interfaces:**
- Consumes: `SecretVault`, `withTx`, the four version columns.
- Produces:
  ```ts
  interface RekeyProgress { table: string; rekeyed: number; remaining: number }
  function rekeyAll(args: {
    pool: pg.Pool;
    credentialsVault: SecretVault;
    triggerVault: SecretVault;
    batchSize?: number;
  }): Promise<RekeyProgress[]>;
  ```

No raw legacy key is passed. Each vault already decrypts `enc_version = 0` through the legacy key it was constructed with, so `rekeyAll` reads and writes entirely through the vault interface and never handles key material itself. A vault built with the wrong legacy key fails on the first row of the affected table, which is the behaviour we want — loud, and before anything is rewritten.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/rekey.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, deriveLegacyKey, encryptSecret, runMigrations } from '../src/index.js';
import { localKeyProvider } from '../src/crypto/keyProvider.js';
import { createWorkspaceKeyring } from '../src/crypto/keyring.js';
import { createSecretVault, type SecretVault } from '../src/crypto/vault.js';
import { rekeyAll } from '../src/crypto/rekey.js';

let pool: Pool;
let ws: string;
let credentialsVault: SecretVault;
let triggerVault: SecretVault;

const legacyCredentials = deriveLegacyKey('legacy-credentials');
const legacyTrigger = deriveLegacyKey('legacy-trigger');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE connections, workflow_triggers, alert_rules, alert_events, workflow_versions,
              workflow_drafts, workflows, workspace_keys CASCADE`,
  );
  ws = randomUUID();
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'rekey')`, [ws]);
  const keyring = createWorkspaceKeyring({ pool, provider: localKeyProvider('m') });
  credentialsVault = createSecretVault({ keyring, legacyKey: legacyCredentials });
  triggerVault = createSecretVault({ keyring, legacyKey: legacyTrigger });
});

/** Seeds one legacy row in each of the four encrypted columns. */
async function seedLegacy(): Promise<{ connectionId: string; workflowId: string; ruleId: string }> {
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
     VALUES ($1,'telegram','C',$2,0) RETURNING id`,
    [ws, encryptSecret('{"botToken":"legacy-bot"}', legacyCredentials)],
  );
  const wf = await pool.query<{ id: string }>(
    `INSERT INTO workflows (workspace_id, name, completion_webhook_url,
       completion_webhook_secret_encrypted, completion_webhook_enc_version)
     VALUES ($1,'W','https://example.com/cb',$2,0) RETURNING id`,
    [ws, encryptSecret('legacy-callback', legacyTrigger)],
  );
  await pool.query(
    `INSERT INTO workflow_triggers (workspace_id, workflow_id, node_id, type, route_key, auth_mode,
       secret_encrypted, secret_enc_version)
     VALUES ($1,$2,'n1','webhook',$3,'token',$4,0)`,
    [ws, wf.rows[0]!.id, randomUUID(), encryptSecret('legacy-trigger-secret', legacyTrigger)],
  );
  const rule = await pool.query<{ id: string }>(
    `INSERT INTO alert_rules (workspace_id, name, type, params, webhook_url,
       webhook_secret_encrypted, webhook_secret_enc_version)
     VALUES ($1,'R','failure_rate','{}','https://example.com/a',$2,0) RETURNING id`,
    [ws, encryptSecret('legacy-alert-secret', legacyTrigger)],
  );
  return { connectionId: conn.rows[0]!.id, workflowId: wf.rows[0]!.id, ruleId: rule.rows[0]!.id };
}

describe('rekeyAll', () => {
  test('re-keys all four columns to v1 with the plaintext unchanged', async () => {
    const seeded = await seedLegacy();
    const progress = await rekeyAll({ pool, credentialsVault, triggerVault });
    expect(progress.map((p) => p.table).sort()).toEqual([
      'alert_rules',
      'connections',
      'workflow_triggers',
      'workflows',
    ]);
    for (const p of progress) {
      expect(p.rekeyed, p.table).toBe(1);
      expect(p.remaining, p.table).toBe(0);
    }
    const conn = await pool.query<{ encrypted_payload: Buffer; enc_version: number }>(
      `SELECT encrypted_payload, enc_version FROM connections WHERE id = $1`,
      [seeded.connectionId],
    );
    expect(conn.rows[0]!.enc_version).toBe(1);
    expect(
      await credentialsVault.decrypt(ws, {
        blob: conn.rows[0]!.encrypted_payload,
        encVersion: 1,
      }),
    ).toBe('{"botToken":"legacy-bot"}');
    const trg = await pool.query<{ secret_encrypted: Buffer; secret_enc_version: number }>(
      `SELECT secret_encrypted, secret_enc_version FROM workflow_triggers WHERE workflow_id = $1`,
      [seeded.workflowId],
    );
    expect(trg.rows[0]!.secret_enc_version).toBe(1);
    expect(
      await triggerVault.decrypt(ws, { blob: trg.rows[0]!.secret_encrypted, encVersion: 1 }),
    ).toBe('legacy-trigger-secret');
  });

  test('a second run is a no-op', async () => {
    await seedLegacy();
    await rekeyAll({ pool, credentialsVault, triggerVault });
    const again = await rekeyAll({ pool, credentialsVault, triggerVault });
    for (const p of again) expect(p.rekeyed, p.table).toBe(0);
  });

  test('a partial run leaves a mixed state where both formats read correctly', async () => {
    await seedLegacy();
    // A second legacy connection, so batchSize 1 leaves one row behind.
    await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'telegram','C2',$2,0)`,
      [ws, encryptSecret('{"botToken":"second"}', legacyCredentials)],
    );
    const first = await rekeyAll({ pool, credentialsVault, triggerVault, batchSize: 1 });
    const conns = first.find((p) => p.table === 'connections')!;
    expect(conns.rekeyed).toBe(1);
    expect(conns.remaining).toBe(1);
    // Both rows must be readable through the vault right now, whichever version they hold.
    const rows = await pool.query<{ encrypted_payload: Buffer; enc_version: number }>(
      `SELECT encrypted_payload, enc_version FROM connections ORDER BY name`,
    );
    const decrypted = await Promise.all(
      rows.rows.map((r) => credentialsVault.decrypt(ws, { blob: r.encrypted_payload, encVersion: r.enc_version })),
    );
    expect(decrypted.sort()).toEqual(['{"botToken":"legacy-bot"}', '{"botToken":"second"}']);
    expect(rows.rows.map((r) => r.enc_version).sort()).toEqual([0, 1]);
  });

  test('rows with a NULL secret are not counted and not touched', async () => {
    await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1, 'NoCallback')`, [ws]);
    const progress = await rekeyAll({ pool, credentialsVault, triggerVault });
    expect(progress.find((p) => p.table === 'workflows')!.rekeyed).toBe(0);
  });

  test('a row that cannot be decrypted stops the run rather than being skipped', async () => {
    await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'telegram','Corrupt',$2,0)`,
      [ws, Buffer.alloc(40, 3)],
    );
    await expect(rekeyAll({ pool, credentialsVault, triggerVault })).rejects.toThrow();
    const still = await pool.query<{ enc_version: number }>(`SELECT enc_version FROM connections`);
    expect(still.rows[0]!.enc_version).toBe(0); // untouched
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/rekey.test.ts
```

Expected: FAIL — `Cannot find module '../src/crypto/rekey.js'`.

- [ ] **Step 3: Implement `packages/db/src/crypto/rekey.ts`**

```ts
import type pg from 'pg';
import { withTx } from '../tx.js';
import { ENC_VERSION_ENVELOPE, ENC_VERSION_LEGACY, type SecretVault } from './vault.js';

const DEFAULT_BATCH_SIZE = 100;

/**
 * The encrypted columns, with the vault family each belongs to. Table and column
 * names are interpolated into SQL below; every value here is a compile-time literal
 * in a frozen array, never user input.
 */
const TARGETS = [
  { table: 'connections', blob: 'encrypted_payload', version: 'enc_version', family: 'credentials' },
  { table: 'workflow_triggers', blob: 'secret_encrypted', version: 'secret_enc_version', family: 'trigger' },
  {
    table: 'workflows',
    blob: 'completion_webhook_secret_encrypted',
    version: 'completion_webhook_enc_version',
    family: 'trigger',
  },
  {
    table: 'alert_rules',
    blob: 'webhook_secret_encrypted',
    version: 'webhook_secret_enc_version',
    family: 'trigger',
  },
] as const;

export interface RekeyProgress {
  table: string;
  rekeyed: number;
  remaining: number;
}

/**
 * Moves every enc_version = 0 secret to the envelope format. A SQL migration cannot
 * do this: the legacy keys live in the application environment, not the database.
 *
 * Each row is re-keyed in its own transaction with a compare-and-set on the version
 * column, which makes the job resumable, idempotent, and safe to run against live
 * traffic. Interrupting it leaves a mixed state both read paths already handle.
 */
export async function rekeyAll(args: {
  pool: pg.Pool;
  credentialsVault: SecretVault;
  triggerVault: SecretVault;
  batchSize?: number;
}): Promise<RekeyProgress[]> {
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
  const out: RekeyProgress[] = [];

  for (const t of TARGETS) {
    const vault = t.family === 'credentials' ? args.credentialsVault : args.triggerVault;
    let rekeyed = 0;

    for (;;) {
      const batch = await args.pool.query<{ id: string; workspace_id: string; blob: Buffer }>(
        `SELECT id, workspace_id, ${t.blob} AS blob FROM ${t.table}
          WHERE ${t.version} = $1 AND ${t.blob} IS NOT NULL
          ORDER BY id
          LIMIT $2`,
        [ENC_VERSION_LEGACY, batchSize],
      );
      if (batch.rows.length === 0) break;

      for (const row of batch.rows) {
        const plaintext = await vault.decrypt(row.workspace_id, {
          blob: row.blob,
          encVersion: ENC_VERSION_LEGACY,
        });
        const sealed = await vault.encrypt(row.workspace_id, plaintext);
        const updated = await withTx(args.pool, async (client) =>
          client.query(
            `UPDATE ${t.table} SET ${t.blob} = $1, ${t.version} = $2
              WHERE id = $3 AND ${t.version} = $4`,
            [sealed.blob, sealed.encVersion, row.id, ENC_VERSION_LEGACY],
          ),
        );
        // A concurrent writer may have already moved this row; that is not an error.
        if ((updated.rowCount ?? 0) > 0) rekeyed += 1;
      }
      if (batch.rows.length < batchSize) break;
    }

    const left = await args.pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM ${t.table} WHERE ${t.version} = $1 AND ${t.blob} IS NOT NULL`,
      [ENC_VERSION_LEGACY],
    );
    out.push({ table: t.table, rekeyed, remaining: Number(left.rows[0]!.c) });
  }

  return out;
}

export { ENC_VERSION_ENVELOPE };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/db exec vitest run test/rekey.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Export and add the CLI command**

Append to `packages/db/src/index.ts`:

```ts
export { rekeyAll, type RekeyProgress } from './crypto/rekey.js';
```

In `apps/cli/package.json`, move `@xperiment/db` and `pg` from `devDependencies` into `dependencies` — the rekey command talks to the database at run time, not just in tests. Then `pnpm install`.

Append to `apps/cli/src/main.ts`, before the final `parseAsync`:

```ts
program
  .command('rekey')
  .description('Re-encrypt legacy secrets under per-workspace envelope encryption')
  .option('--batch-size <n>', 'rows per query', '100')
  .action(async (opts: { batchSize: string }) => {
    const { createKeyProviderFromEnv, createPool, createSecretVault, createWorkspaceKeyring, deriveLegacyKey, rekeyAll } =
      await import('@xperiment/db');
    const pool = createPool();
    try {
      const keyring = createWorkspaceKeyring({ pool, provider: await createKeyProviderFromEnv() });
      const progress = await rekeyAll({
        pool,
        credentialsVault: createSecretVault({
          keyring,
          legacyKey: deriveLegacyKey(process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me'),
        }),
        triggerVault: createSecretVault({
          keyring,
          legacyKey: deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
        }),
        batchSize: Number(opts.batchSize),
      });
      for (const p of progress) console.log(`${p.table.padEnd(20)} rekeyed=${p.rekeyed}  remaining=${p.remaining}`);
      // Non-zero remaining means the legacy env keys must stay configured.
      if (progress.some((p) => p.remaining > 0)) process.exit(2);
    } catch (e) {
      fail(e);
    } finally {
      await pool.end();
    }
  });
```

The dynamic `import` keeps `@xperiment/db` — and therefore a database connection — out of the startup path of every other CLI command.

- [ ] **Step 6: Run it against the dev database**

```bash
pnpm --filter @xperiment/cli exec tsx src/main.ts rekey
```

Expected: four lines. Any pre-existing dev rows move to v1; a clean database prints `rekeyed=0  remaining=0` throughout and exits 0.

- [ ] **Step 7: Commit**

```bash
pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/cli typecheck && pnpm --filter @xperiment/db test:cov
git add packages/db/src/crypto/rekey.ts packages/db/src/index.ts packages/db/test/rekey.test.ts apps/cli pnpm-lock.yaml
git commit -m "feat: add a resumable backfill for legacy encrypted secrets"
```

---

### Task 14: Tighten, document, verify

Removes the transitional scaffolding now that nothing reads it, and closes the workspace-filter hole permanently by making it impossible to omit.

**Files:**
- Modify: `apps/api/src/routes/deps.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `packages/db/src/repos/connections.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Test: every suite

**Interfaces:**
- Consumes: everything from Tasks 1–13.
- Produces: `ResolvedServerDeps` loses `triggerKey` and `credentialsKey`; `getConnectionWithPayload(db, id, workspaceId)` — third parameter **required**.

- [ ] **Step 1: Make the workspace filter mandatory**

In `packages/db/src/repos/connections.ts`, drop the optional branch:

```ts
/**
 * `workspaceId` is required. It was optional, and the worker omitted it (runTask.ts:56),
 * so any published IR could resolve any connection UUID in the database. Requiring it
 * turns that class of omission into a compile error.
 */
export async function getConnectionWithPayload(
  db: Db,
  id: string,
  workspaceId: string,
): Promise<(ConnectionRow & { workspaceId: string; encryptedPayload: Buffer; encVersion: number }) | null> {
  const r = await db.query(`SELECT * FROM connections WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    ...mapConnection(row),
    workspaceId: row['workspace_id'] as string,
    encryptedPayload: row['encrypted_payload'] as Buffer,
    encVersion: row['enc_version'] as number,
  };
}
```

- [ ] **Step 2: Typecheck to find every remaining omission**

```bash
pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/api typecheck && pnpm --filter @xperiment/worker typecheck
```

Expected: errors only in `packages/db/test/connections.test.ts`, where three calls pass two arguments. Add `DEFAULT_WORKSPACE_ID` to each. If a *source* file appears in the errors, a call site was missed in Tasks 9–13 — fix it there, not by re-widening the signature.

- [ ] **Step 3: Remove the legacy dep fields**

Delete `triggerKey: Buffer;` and `credentialsKey: Buffer;` from `ResolvedServerDeps` in `apps/api/src/routes/deps.ts`, and delete the two `deriveLegacyKey(...)` assignments from `resolvedDeps` in `apps/api/src/server.ts`. Keep the optional `deps.triggerKey`/`deps.credentialsKey` overrides out of `ServerDeps` too.

```bash
pnpm --filter @xperiment/api typecheck
```

Expected: PASS. Any error names a route still reading the raw key — convert it to the vault rather than restoring the field.

Then confirm nothing outside the vault touches a raw key:

```bash
cd "<repo-root>" && grep -rn "credentialsKey\|triggerKey\|alertKey" --include=*.ts apps packages | grep -v node_modules
```

Expected: no output. `deriveLegacyKey` should now appear only in the three entrypoints, the CLI rekey command, and tests.

- [ ] **Step 4: Document the configuration**

Add to `.env.example`:

```bash
# SEC-001 envelope encryption. `local` derives a root key from KEK_MASTER_KEY with
# scrypt; `gcp-kms` wraps through a Cloud KMS CryptoKey and requires KMS_KEY_NAME.
KMS_PROVIDER=local
KEK_MASTER_KEY=xperiment-dev-kek-master-change-me
# KMS_KEY_NAME=projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY
# How long a decrypted workspace key stays in process memory. Lower means more KMS
# calls but faster propagation when a key is destroyed.
KEK_CACHE_TTL_MS=300000

# Read-only after the backfill: these decrypt enc_version = 0 rows only. Remove them
# once `xperiment rekey` reports remaining=0 on all four tables.
TRIGGER_SECRET_KEY=xperiment-dev-trigger-secret-change-me
CREDENTIALS_SECRET_KEY=xperiment-dev-credentials-secret-change-me
```

Add a `## Security` section to `README.md` covering: the three-tier key hierarchy in four sentences; that `KMS_PROVIDER=gcp-kms` makes KMS a hard runtime dependency and credentialed workflows **fail closed** when it is unreachable with a cold cache; the `xperiment rekey` procedure and the fact that the two legacy keys must stay set until it reports zero remaining; and that `GET /v1/audit` requires `audit:read` (admin and owner only).

```bash
pnpm --filter @xperiment/cli exec tsx src/main.ts rekey
```

Expected: `remaining=0` on all four tables — which is the check the README tells an operator to run.

- [ ] **Step 5: Full verification**

```bash
pnpm -r typecheck
```

Expected: PASS across every package.

```bash
pnpm -r test
```

Expected: PASS across every package.

```bash
pnpm --filter @xperiment/db test:cov && pnpm --filter @xperiment/api test:cov && pnpm --filter @xperiment/worker test:cov && pnpm --filter @xperiment/gateway test:cov
```

Expected: all four thresholds (lines, statements, functions, branches ≥ 80) met per package. If `keyProvider.ts` is short on branch coverage, the uncovered branches will be the `toBuffer` null path and the `clientFactory` default — the first is already tested, and the second is the real `@google-cloud/kms` import, which is excluded from meaningful testing by design. If it drags the package under threshold, add `src/crypto/keyProvider.ts` default-factory lines to the `coverage.exclude` list in `packages/db/vitest.config.ts` with a comment saying why, rather than writing a test that constructs a real KMS client.

- [ ] **Step 6: Run the e2e suites**

```bash
pnpm --filter @xperiment/web test:e2e
```

Expected: PASS. P adds no web surface, so this is a regression check: the connections page, the alerts page and the workflow callback panel all now traverse the vault.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/cli packages/db/src/repos/connections.ts packages/db/test/connections.test.ts .env.example README.md
git commit -m "refactor: require the workspace on credential reads and drop the global keys"
```

---

## Self-Review

**1. Spec coverage.** Every section maps to a task.

| Spec section | Task |
|---|---|
| §2 key hierarchy, `workspace_keys`, first-use race, caching | 3, 4 |
| §3 `KeyProvider`, both providers, configuration table | 2, 14 |
| §4 `SecretVault`, `EncryptedSecret`, v1 blob format, AAD, version column | 5, 3 |
| §4 nullable columns write version 0 | 7 (`COALESCE($N, 0)` on every insert) |
| §5 backfill, CAS resumability, `secret.rekey_batch` | 13 — **gap, see below** |
| §6 `audit_events`, emission rule, metadata allowlist, action catalog | 3, 6, 9, 10, 11, 12 |
| §7 `GET /v1/audit`, `audit:read`, id ordering, no global rows, no web page | 8 |
| §8 worker workspace filter | 12, 14 |
| §9 file list, repo widening table, `triggerView` → `Promise.all` | 7, 10 |
| §10 test list including the race and the transactional emission | 4 (Step 6), 6, 9 (Step 5), 12 (Step 8) |
| §11 fail closed, legacy keys until backfill, workspace deletion | 12 (Step 4 comment), 14 (Step 4 docs) |

**One gap found and closed:** spec §5 specifies one `secret.rekey_batch` audit event per run carrying the totals, and Task 13 as written emits none. Rather than add a fifth commit-time change to Task 13's already-long step list, add to Task 13 Step 5, inside the CLI action after `rekeyAll` returns:

```ts
      await appendAuditEvent(pool, {
        actorKind: 'system',
        action: 'secret.rekey_batch',
        metadata: Object.fromEntries(progress.map((p) => [p.table, p.rekeyed])),
      });
```

`appendAuditEvent` joins the dynamic import list. This sits in the CLI rather than in `rekeyAll` because the event describes *a run*, and `rekeyAll` has no notion of a run boundary — a caller could invoke it in a loop. `workspaceId` is null: a rekey spans every workspace, so attributing it to one would be wrong, and §7 already guarantees global rows never surface in a workspace's audit view. `metadata` stays within the scalar type: table name → count.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the code. Three steps deliberately reference an existing helper by name rather than reproducing it — `seedWorkspaceWithRoles` (Task 8), `activateWebhookWorkflow` (Task 10), `registerAndLogin` (Task 11), `seedConnection`/`seedExecutionUsing` (Task 12). Each names the file it already lives in, which is a pointer to real code, not a placeholder.

**3. Type consistency.** Checked across tasks:

- `EncryptedSecret { blob, encVersion }` — same field names in Tasks 5, 7, 9, 10, 12, 13.
- `SecretVault.decrypt(workspaceId, secret)` takes the object, never two positional buffers — consistent at all six call sites.
- `ENC_VERSION_LEGACY = 0` / `ENC_VERSION_ENVELOPE = 1` used by name in Tasks 5, 7, 13; the SQL uses the literal `0` in `COALESCE` defaults, which is the same value.
- `getWorkflowCallback` and `getAlertWebhook` both return `{ workspaceId, url, secretEncrypted, encVersion }` — the identical shape consumed in Task 12 Step 5.
- `TriggerRow.secretEncVersion` (not `encVersion`) — the trigger column is `secret_enc_version`, and Tasks 7, 10 and 12 all use the longer name.
- `auditActor(req)` returns exactly the field names `AuditEventInput` accepts, so `...auditActor(req)` spreads cleanly in Tasks 9, 10, 11.
- `AuthContext` gains `apiKeyId` in Task 8 before `auditActor` reads it in the same task.
- `appendAuditEvent(db, input)` takes `Db`, satisfied by both the pool (Tasks 9 test, 11, 12) and a `PoolClient` (Tasks 6, 9).

**4. Ordering.** Tasks 1–8 are additive and every suite stays green throughout; the one intentional red window is between Task 10 and Task 12, where a v1 trigger secret exists that the gateway and worker still read with a legacy key. Task 10 Step 7 names this explicitly so an implementer does not treat it as a bug. Task 14 is the only task that removes anything.

