import { type Db } from '../pool.js';

/**
 * Find executions by what was in the webhook body that started them.
 *
 * The support question this answers is always the same shape: a customer gives an order
 * number, and somebody has to find the run. Status filtering does not help — the run is
 * usually SUCCEEDED, sitting among four hundred others.
 */

/**
 * The shortest query the trigram index can serve.
 *
 * Measured, not chosen: a trigram is three consecutive characters, so at two characters
 * Postgres cannot use the index at all and sequentially scans every webhook body in the
 * table. Enforced as a 400 rather than run slowly.
 */
export const MIN_SEARCH_LENGTH = 3;
export const MAX_SEARCH_LENGTH = 200;

/**
 * Escape the characters ILIKE treats as wildcards.
 *
 * Without this a search for `50%` matches everything after "50", and a query of a single
 * `%` matches every row in the workspace — a scan somebody can ask for by accident. The
 * backslash goes first, or it would escape the escapes added after it.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface PayloadMatch {
  executionId: string;
  workflowId: string;
  status: string;
  createdAt: string;
  nodeId: string | null;
}

/**
 * Returns execution rows and NOT payload content.
 *
 * The caller already needs `execution:run` to search, and the same permission gates
 * reading a payload — but echoing the matched body here would put customer data into a
 * list view that gets left open on a shared screen. Clicking through re-checks.
 */
export async function searchExecutionsByPayload(
  db: Db,
  args: { workspaceId: string; query: string; limit: number },
): Promise<PayloadMatch[]> {
  const pattern = `%${escapeLikePattern(args.query)}%`;
  const r = await db.query(
    `SELECT e.id, e.workflow_id, e.status, e.created_at, t.node_id
       FROM trigger_events t
       JOIN executions e ON e.trigger_event_id = t.id
      WHERE t.workspace_id = $1
        AND e.workspace_id = $1
        AND t.payload_json::text ILIKE $2
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $3`,
    [args.workspaceId, pattern, args.limit],
  );
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    executionId: row['id'] as string,
    workflowId: row['workflow_id'] as string,
    status: row['status'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
    nodeId: (row['node_id'] as string | null) ?? null,
  }));
}
