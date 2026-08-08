import { authoredNodeId } from './format';

interface AttemptRow {
  nodeId: string;
  status: string;
  attempt: number;
}

/**
 * Worst-or-most-active first.
 *
 * A loop body is many rows on the canvas' one node, so folding them needs a rule: one
 * failed iteration must colour the body red, one running iteration must read as live,
 * and green is only correct when nothing worse is present. An unknown status sorts last
 * so a future engine state can never mask a failure.
 */
export const RUN_STATUS_RANK: readonly string[] = [
  'FAILED',
  'TIMED_OUT',
  'RUNNING',
  'RETRY_SCHEDULED',
  'WAITING',
  'QUEUED',
  'READY',
  'PENDING',
  'CANCELED',
  'SKIPPED',
  'SUCCEEDED',
];

function rank(status: string): number {
  const at = RUN_STATUS_RANK.indexOf(status);
  return at === -1 ? RUN_STATUS_RANK.length : at;
}

/**
 * Per-node status for the canvas, from an execution's attempt rows.
 *
 * Two folds: keep the highest attempt per exact node id (mirroring the DISTINCT ON the
 * server uses for latest state), then fold loop instances onto the id the author wrote.
 */
export function runStatusByNode(rows: readonly AttemptRow[]): Map<string, string> {
  const latestByExactId = new Map<string, AttemptRow>();
  for (const row of rows) {
    const seen = latestByExactId.get(row.nodeId);
    if (seen === undefined || row.attempt > seen.attempt) latestByExactId.set(row.nodeId, row);
  }

  const byAuthored = new Map<string, string>();
  for (const row of latestByExactId.values()) {
    const id = authoredNodeId(row.nodeId);
    const current = byAuthored.get(id);
    if (current === undefined || rank(row.status) < rank(current)) byAuthored.set(id, row.status);
  }
  return byAuthored;
}
