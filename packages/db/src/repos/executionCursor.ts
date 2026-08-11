import { createHash } from 'node:crypto';

/**
 * Keyset cursors that carry the filter they were minted under.
 *
 * A keyset cursor is just a position — `(created_at, id) < (…)`. Hand a cursor minted
 * under `status=FAILED` to a request with no status and the query happily runs: it
 * returns the page of *unfiltered* rows sitting after that position. No error, no empty
 * result, just quietly the wrong set. Binding the filter into the cursor turns that into
 * a rejection the caller can act on.
 *
 * The hash is a consistency check, not a security boundary. A caller who forges one gets
 * their own workspace's rows in a confusing order; the workspace predicate is enforced
 * separately and is not encoded here.
 */

export interface ExecutionFilter {
  workflowId?: string | undefined;
  status?: readonly string[] | undefined;
}

/** Stable across servers and orderings: the same filter always hashes the same. */
export function filterFingerprint(filter: ExecutionFilter): string {
  const canonical = JSON.stringify({
    workflowId: filter.workflowId ?? null,
    status: [...(filter.status ?? [])].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function encodeExecutionCursor(createdAt: Date, id: string, filter: ExecutionFilter): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}|${filterFingerprint(filter)}`).toString('base64');
}

export type CursorResult =
  | { ok: true; createdAt: string; id: string }
  | { ok: false; reason: 'malformed' | 'filter_changed' };

/**
 * Cursors are ephemeral — one page of results — so an unreadable one is rejected rather
 * than salvaged. Silently ignoring it would show page one while the caller believes they
 * are on page four.
 */
export function decodeExecutionCursor(cursor: string, filter: ExecutionFilter): CursorResult {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parts = decoded.split('|');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [createdAt, id, fingerprint] = parts as [string, string, string];
  if (createdAt === '' || id === '') return { ok: false, reason: 'malformed' };
  if (Number.isNaN(Date.parse(createdAt))) return { ok: false, reason: 'malformed' };
  if (fingerprint !== filterFingerprint(filter)) return { ok: false, reason: 'filter_changed' };
  return { ok: true, createdAt, id };
}
