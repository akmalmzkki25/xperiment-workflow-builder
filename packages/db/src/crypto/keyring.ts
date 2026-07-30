import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { KeyProvider } from './keyProvider.js';

export const DEFAULT_KEK_CACHE_TTL_MS = 300000;

const KEK_LEN = 32;

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

  /**
   * A KEK can only be unwrapped by the root key that wrapped it. Without this check the
   * mismatch surfaces as "Unsupported state or unable to authenticate data" from the GCM
   * layer, which tells an operator nothing. Naming the recorded root key turns
   * "rotated KEK_MASTER_KEY without re-wrapping" into a diagnosable error.
   */
  function assertSameRootKey(workspaceId: string, rootKeyId: string): void {
    if (rootKeyId === args.provider.keyId) return;
    throw new Error(
      `workspace ${workspaceId} key was wrapped by root key ${rootKeyId}, but the configured provider is ${args.provider.keyId}`,
    );
  }

  async function load(workspaceId: string): Promise<Buffer> {
    const existing = await args.pool.query<{ wrapped_key: Buffer; root_key_id: string }>(
      `SELECT wrapped_key, root_key_id FROM workspace_keys WHERE workspace_id = $1`,
      [workspaceId],
    );
    const found = existing.rows[0];
    if (found) {
      assertSameRootKey(workspaceId, found.root_key_id);
      return args.provider.unwrap(found.wrapped_key);
    }

    const fresh = randomBytes(KEK_LEN);
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
    // Unconditional re-read. If the insert lost the race, `fresh` must be discarded and
    // never used to encrypt anything, or the two racers encrypt this workspace under two
    // different keys and half its secrets become unreadable. Verified by deliberately
    // returning `fresh` here — the race test fails 3/3 when this re-read is removed.
    const settled = await args.pool.query<{ wrapped_key: Buffer; root_key_id: string }>(
      `SELECT wrapped_key, root_key_id FROM workspace_keys WHERE workspace_id = $1`,
      [workspaceId],
    );
    const winner = settled.rows[0];
    if (!winner) throw new Error(`workspace key missing after insert for workspace ${workspaceId}`);
    assertSameRootKey(workspaceId, winner.root_key_id);
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
