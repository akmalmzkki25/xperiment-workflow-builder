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
    const before = provider.unwraps;
    const b = await keyring.keyFor(ws);
    expect(a.equals(b)).toBe(true);
    expect(provider.unwraps).toBeGreaterThan(before);
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
    // Warm the pool: a cold pool serialises the connections and hides the race.
    await Promise.all([...Array(5)].map(() => pool.query('SELECT 1')));
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
    await pool.query(`UPDATE workspace_keys SET wrapped_key = $1 WHERE workspace_id = $2`, [Buffer.alloc(60, 7), ws]);
    await expect(createWorkspaceKeyring({ pool, provider }).keyFor(ws)).rejects.toThrow();
  });
});
