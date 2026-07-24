import type pg from 'pg';
import { type Db } from '../pool.js';
import { appendEvent, casNode } from './executions.js';
import { insertOutbox } from './outbox.js';

export type WaitKind = 'timer' | 'event' | 'approval';
export type WaitStatus = 'open' | 'resolved' | 'expired';

export interface WaitRow {
  id: string;
  executionId: string;
  nodeId: string;
  attempt: number;
  workspaceId: string;
  kind: WaitKind;
  resumeToken: string | null;
  resumeAt: string | null;
  expiresAt: string | null;
  fallback: string | null;
  message: string | null;
  status: WaitStatus;
  decision: string | null;
  resolvedBy: string | null;
  comment: string | null;
}

function mapWait(r: Record<string, unknown>): WaitRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    id: r['id'] as string,
    executionId: r['execution_id'] as string,
    nodeId: r['node_id'] as string,
    attempt: Number(r['attempt']),
    workspaceId: r['workspace_id'] as string,
    kind: r['kind'] as WaitKind,
    resumeToken: (r['resume_token'] as string | null) ?? null,
    resumeAt: ts(r['resume_at']),
    expiresAt: ts(r['expires_at']),
    fallback: (r['fallback'] as string | null) ?? null,
    message: (r['message'] as string | null) ?? null,
    status: r['status'] as WaitStatus,
    decision: (r['decision'] as string | null) ?? null,
    resolvedBy: (r['resolved_by'] as string | null) ?? null,
    comment: (r['comment'] as string | null) ?? null,
  };
}

export async function openWait(
  db: Db,
  args: {
    executionId: string;
    nodeId: string;
    attempt: number;
    kind: WaitKind;
    resumeToken?: string;
    resumeAt?: Date;
    expiresAt?: Date;
    fallback?: string;
    message?: string;
  },
): Promise<WaitRow> {
  const r = await db.query(
    `INSERT INTO execution_waits
       (workspace_id, execution_id, node_id, attempt, kind, resume_token, resume_at, expires_at, fallback, message)
     SELECT e.workspace_id, e.id, $2, $3, $4, $5, $6, $7, $8, $9 FROM executions e WHERE e.id = $1
     RETURNING *`,
    [
      args.executionId,
      args.nodeId,
      args.attempt,
      args.kind,
      args.resumeToken ?? null,
      args.resumeAt ?? null,
      args.expiresAt ?? null,
      args.fallback ?? null,
      args.message ?? null,
    ],
  );
  return mapWait(r.rows[0] as Record<string, unknown>);
}

/** CAS `open → status`; returns false if the wait was already closed. */
export async function resolveWait(
  client: pg.PoolClient,
  args: { waitId: string; status: 'resolved' | 'expired'; decision?: string; resolvedBy?: string; comment?: string },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE execution_waits
     SET status = $2, decision = $3, resolved_by = $4, comment = $5, resolved_at = now()
     WHERE id = $1 AND status = 'open'`,
    [args.waitId, args.status, args.decision ?? null, args.resolvedBy ?? null, args.comment ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getOpenWaitByToken(db: Db, token: string): Promise<WaitRow | null> {
  const r = await db.query(`SELECT * FROM execution_waits WHERE resume_token = $1 AND status = 'open'`, [token]);
  return r.rowCount ? mapWait(r.rows[0] as Record<string, unknown>) : null;
}

export async function getOpenApprovalWait(
  db: Db,
  args: { executionId: string; nodeId: string; workspaceId: string },
): Promise<WaitRow | null> {
  const r = await db.query(
    `SELECT * FROM execution_waits
     WHERE execution_id = $1 AND node_id = $2 AND workspace_id = $3 AND kind = 'approval' AND status = 'open'`,
    [args.executionId, args.nodeId, args.workspaceId],
  );
  return r.rowCount ? mapWait(r.rows[0] as Record<string, unknown>) : null;
}

export async function listOpenApprovals(
  db: Db,
  args: { workspaceId: string; limit: number },
): Promise<{ waitId: string; executionId: string; workflowId: string; nodeId: string; message: string | null; expiresAt: string | null; createdAt: string }[]> {
  const r = await db.query(
    `SELECT w.id, w.execution_id, e.workflow_id, w.node_id, w.message, w.expires_at, w.created_at
     FROM execution_waits w JOIN executions e ON e.id = w.execution_id
     WHERE w.workspace_id = $1 AND w.kind = 'approval' AND w.status = 'open'
     ORDER BY w.created_at DESC LIMIT $2`,
    [args.workspaceId, args.limit],
  );
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    waitId: row['id'] as string,
    executionId: row['execution_id'] as string,
    workflowId: row['workflow_id'] as string,
    nodeId: row['node_id'] as string,
    message: (row['message'] as string | null) ?? null,
    expiresAt: ts(row['expires_at']),
    createdAt: ts(row['created_at']) as string,
  }));
}

export async function dueWaits(client: pg.PoolClient, limit: number): Promise<WaitRow[]> {
  const r = await client.query(
    `SELECT * FROM execution_waits
     WHERE status = 'open' AND (
       (resume_at IS NOT NULL AND resume_at <= now()) OR
       (expires_at IS NOT NULL AND expires_at <= now())
     )
     ORDER BY COALESCE(resume_at, expires_at)
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Record<string, unknown>[]).map(mapWait);
}

/**
 * Resolves an open wait and its WAITING node in one step, then emits a
 * `node.completed` so the orchestrator advances the run. Shared by the approvals
 * API, the gateway event endpoint, and the scheduler sweep. Idempotent: if the
 * wait is already closed the whole operation is a no-op (returns false), which
 * makes the timer-sweep-vs-decision race safe.
 */
export async function applyResume(
  client: pg.PoolClient,
  args: {
    wait: Pick<WaitRow, 'id' | 'executionId' | 'nodeId' | 'attempt'>;
    waitStatus: 'resolved' | 'expired';
    terminal: 'SUCCEEDED' | 'FAILED';
    outputPort?: string;
    output?: unknown;
    error?: unknown;
    decision?: string;
    resolvedBy?: string;
    comment?: string;
  },
): Promise<boolean> {
  const closed = await resolveWait(client, {
    waitId: args.wait.id,
    status: args.waitStatus,
    ...(args.decision ? { decision: args.decision } : {}),
    ...(args.resolvedBy ? { resolvedBy: args.resolvedBy } : {}),
    ...(args.comment ? { comment: args.comment } : {}),
  });
  if (!closed) return false; // lost the race — another resolver already handled it

  const { executionId, nodeId, attempt } = args.wait;
  const written = await casNode(client, {
    executionId,
    nodeId,
    attempt,
    from: ['WAITING'],
    to: args.terminal,
    patch: {
      ...(args.terminal === 'SUCCEEDED'
        ? { outputJson: args.output ?? null, outputPort: args.outputPort ?? 'main' }
        : { errorJson: args.error ?? { code: 'wait_failed', message: 'wait resolved to failure' } }),
      completedAt: true,
    },
  });
  // The node already left WAITING (e.g. the execution was finalized elsewhere and
  // its waits closed). Don't emit a completion the orchestrator would ignore.
  if (!written) return false;
  await appendEvent(client, {
    executionId,
    eventType: 'node.resumed',
    nodeId,
    payload: { attempt, terminal: args.terminal, ...(args.outputPort ? { outputPort: args.outputPort } : {}) },
  });
  await insertOutbox(client, {
    eventType: 'node.completed',
    payload: {
      executionId,
      nodeId,
      attempt,
      status: args.terminal,
      ...(args.terminal === 'SUCCEEDED' ? { outputPort: args.outputPort ?? 'main' } : {}),
    },
  });
  return true;
}

/**
 * Closes every open wait for an execution and skips its WAITING nodes. Call this
 * whenever an execution is finalized to a terminal state (FAILED/TIMED_OUT) so a
 * sibling branch's approval/event wait cannot dangle — leaking a live resume token
 * or a stale entry in the pending-approvals list. Returns the number closed.
 */
export async function closeOpenWaits(client: pg.PoolClient, executionId: string): Promise<number> {
  const open = await client.query(
    `SELECT id, node_id, attempt FROM execution_waits WHERE execution_id = $1 AND status = 'open' FOR UPDATE`,
    [executionId],
  );
  let closed = 0;
  for (const row of open.rows as Record<string, unknown>[]) {
    const ok = await resolveWait(client, { waitId: row['id'] as string, status: 'expired' });
    if (!ok) continue;
    // Only emit node.skipped if THIS call actually skipped the node. A caller may
    // have already skipped it (e.g. the cancel handler skips WAITING nodes before
    // calling closeOpenWaits); double-emitting would duplicate the audit event.
    const skipped = await casNode(client, {
      executionId,
      nodeId: row['node_id'] as string,
      attempt: Number(row['attempt']),
      from: ['WAITING'],
      to: 'SKIPPED',
      patch: { completedAt: true },
    });
    if (skipped) {
      await appendEvent(client, { executionId, eventType: 'node.skipped', nodeId: row['node_id'] as string });
    }
    closed += 1;
  }
  return closed;
}

export async function waitsForExecution(db: Db, executionId: string): Promise<WaitRow[]> {
  const r = await db.query(`SELECT * FROM execution_waits WHERE execution_id = $1 ORDER BY created_at`, [executionId]);
  return (r.rows as Record<string, unknown>[]).map(mapWait);
}
