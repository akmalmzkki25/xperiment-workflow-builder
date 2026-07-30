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

  async function load(workspaceId: string): Promise<Buffer> {
    const existing = await args.pool.query<{ wrapped_key: Buffer }>(
      `SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1`,
      [workspaceId],
    );
    const found = existing.rows[0];
    if (found) return args.provider.unwrap(found.wrapped_key);

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
