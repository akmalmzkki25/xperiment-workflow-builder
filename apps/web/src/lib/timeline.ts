import type { ExecutionNodeRow } from './api';

/**
 * Attempts grouped under their node, in first-seen order.
 *
 * The server returns rows ordered by node id then attempt; this preserves that order
 * rather than re-sorting, so the timeline reads the same way the query did.
 */
export function groupAttemptsByNode(nodes: readonly ExecutionNodeRow[]): Map<string, ExecutionNodeRow[]> {
  const map = new Map<string, ExecutionNodeRow[]>();
  for (const row of nodes) {
    map.set(row.nodeId, [...(map.get(row.nodeId) ?? []), row]);
  }
  return map;
}

/**
 * A one-line error for an attempt, or null when there is nothing to say.
 *
 * `errorJson` is whatever the engine normalised; only `code` and `message` are read,
 * deliberately — `details` can carry a provider's whole response body.
 */
export function attemptError(errorJson: unknown): string | null {
  if (typeof errorJson !== 'object' || errorJson === null) return null;
  const e = errorJson as { message?: unknown; code?: unknown };
  const parts = [e.code, e.message].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.length === 0 ? null : parts.join(': ');
}

/** The port to show beside an attempt. `main` is the default path and says nothing. */
export function attemptPortLabel(outputPort: string | null): string | null {
  if (!outputPort || outputPort === 'main') return null;
  return outputPort;
}
