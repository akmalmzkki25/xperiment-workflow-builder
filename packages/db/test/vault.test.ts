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

  test('a legacy blob labelled as envelope is always rejected, whatever its first byte', async () => {
    // A legacy blob starts with a random 12-byte IV, so ~1 in 256 of them happen to
    // begin with the v1 marker. Those get past the marker check and are rejected one
    // stage later, by the length bound or the GCM tag. Either way the read fails — which
    // is the guarantee that matters, and asserting a specific message here would make
    // the test 1/256 flaky. This residual ambiguity is exactly why enc_version is a
    // column rather than a byte inside the blob.
    const ws = await makeWorkspace();
    const v = vault();
    for (let i = 0; i < 40; i += 1) {
      const mislabelled = { blob: encryptSecret(`x-${i}`, legacyKey), encVersion: ENC_VERSION_ENVELOPE };
      await expect(v.decrypt(ws, mislabelled)).rejects.toThrow();
    }
  });

  test('the marker check names the failure when the first byte is not the marker', async () => {
    const ws = await makeWorkspace();
    const blob = encryptSecret('x', legacyKey);
    blob[0] = 0x02; // deterministically not the v1 marker
    await expect(vault().decrypt(ws, { blob, encVersion: ENC_VERSION_ENVELOPE })).rejects.toThrow(/format/i);
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

  test('a legacy blob is NOT readable by a vault holding the other family key', async () => {
    // The converse of the test above, and the reason the two vaults exist at all: at v0
    // the families are distinct, so one vault must not open the other's legacy secrets.
    const ws = await makeWorkspace();
    const keyring = createWorkspaceKeyring({ pool, provider: localKeyProvider('m') });
    const credentials = createSecretVault({ keyring, legacyKey: deriveLegacyKey('cred') });
    const trigger = createSecretVault({ keyring, legacyKey: deriveLegacyKey('trig') });
    const legacy = { blob: encryptSecret('old', deriveLegacyKey('cred')), encVersion: ENC_VERSION_LEGACY };
    expect(await credentials.decrypt(ws, legacy)).toBe('old');
    await expect(trigger.decrypt(ws, legacy)).rejects.toThrow();
  });
});
