import { evaluateQuota, isBlocked, periodStart, resolveLimits, type LimitKey } from '@xperiment/plans';
import type pg from 'pg';
import { type Db } from '../pool.js';
import { withTx } from '../tx.js';
import { getQuotaUsage, getWorkspacePlan } from './entitlements.js';
import { insertOutbox } from './outbox.js';

export const PAYLOAD_CAP_BYTES = 262144;

export class PayloadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Payload of ${bytes} bytes exceeds the ${PAYLOAD_CAP_BYTES}-byte cap`);
    this.name = 'PayloadTooLargeError';
  }
}

function capJson(value: unknown): string {
  const s = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes > PAYLOAD_CAP_BYTES) throw new PayloadTooLargeError(bytes);
  return s;
}

export interface ExecutionRow {
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  triggerEventId: string | null;
  status: string;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

function mapExecution(r: Record<string, unknown>): ExecutionRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    workflowId: r['workflow_id'] as string,
    workflowVersionId: r['workflow_version_id'] as string,
    triggerEventId: (r['trigger_event_id'] as string | null) ?? null,
    status: r['status'] as string,
    errorSummary: (r['error_summary'] as string | null) ?? null,
    startedAt: ts(r['started_at']),
    completedAt: ts(r['completed_at']),
    createdAt: ts(r['created_at'])!,
  };
}

export interface QuotaRefusal {
  outcome: 'quota_exceeded';
  metric: LimitKey;
  used: number;
  limit: number;
}

/**
 * A union rather than a nullable field: every caller must branch on `outcome`, so a
 * new refusal can never be silently ignored by an existing call site.
 */
export type CreateExecutionResult = { outcome: 'created' | 'duplicate'; execution: ExecutionRow } | QuotaRefusal;

/**
 * Reserve one execution against the workspace's monthly cap.
 *
 * `FOR UPDATE` alone would lock nothing on the first request of a period, because the
 * row does not exist yet — precisely when a burst is most likely. So the row is
 * materialised first, then locked, then compared, then incremented. Every concurrent
 * creation for this workspace and period contends on that one row, which makes the
 * check and the increment atomic with respect to each other and to the execution insert.
 */
async function checkAndConsumeExecutionQuota(
  client: pg.PoolClient,
  workspaceId: string,
  period: Date,
): Promise<QuotaRefusal | null> {
  const plan = await getWorkspacePlan(client, workspaceId);
  const limits = resolveLimits(plan.planCode, plan.limitOverrides);
  const limit = limits.executionsPerMonth;
  if (limit === null) return null; // unlimited: no row to touch, no lock to take

  await client.query(
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     VALUES ($1,$2,'execution',0) ON CONFLICT DO NOTHING`,
    [workspaceId, period],
  );
  const locked = await client.query(
    `SELECT quantity FROM workspace_usage_counters
     WHERE workspace_id=$1 AND period_start=$2 AND metric='execution' FOR UPDATE`,
    [workspaceId, period],
  );
  const used = Number((locked.rows[0] as { quantity: string }).quantity);

  const usage = await getQuotaUsage(client, workspaceId, period);
  const lines = evaluateQuota(limits, { ...usage, executionsPerMonth: used }, plan.allowOverage);
  if (isBlocked(lines, 'executionsPerMonth')) {
    return { outcome: 'quota_exceeded', metric: 'executionsPerMonth', used, limit };
  }

  await client.query(
    `UPDATE workspace_usage_counters SET quantity = quantity + 1
     WHERE workspace_id=$1 AND period_start=$2 AND metric='execution'`,
    [workspaceId, period],
  );
  return null;
}

export async function createExecutionWithTrigger(
  pool: pg.Pool,
  args: {
    workflowId: string;
    versionId: string;
    idempotencyKey: string;
    payload: unknown;
    nodeIds: string[];
    executionTimeoutMs: number;
  },
): Promise<CreateExecutionResult> {
  return withTx(pool, async (client) => {
    // workspace_id is inherited from the workflow row — tenancy by construction.
    const te = await client.query(
      `INSERT INTO trigger_events (workspace_id, workflow_id, idempotency_key, payload_json)
       SELECT w.workspace_id, w.id, $2, $3 FROM workflows w WHERE w.id = $1
       ON CONFLICT (workflow_id, idempotency_key) DO NOTHING RETURNING id, workspace_id`,
      [args.workflowId, args.idempotencyKey, capJson(args.payload)],
    );
    if (!te.rowCount) {
      const existing = await client.query(
        `SELECT e.* FROM executions e
         JOIN trigger_events t ON t.id = e.trigger_event_id
         WHERE t.workflow_id = $1 AND t.idempotency_key = $2`,
        [args.workflowId, args.idempotencyKey],
      );
      // A replay is free: it consumes no quota because it starts no new work.
      return { outcome: 'duplicate', execution: mapExecution(existing.rows[0] as Record<string, unknown>) };
    }
    const { id: triggerEventId, workspace_id: workspaceId } = te.rows[0] as { id: string; workspace_id: string };

    const refusal = await checkAndConsumeExecutionQuota(client, workspaceId, periodStart(new Date()));
    if (refusal) return refusal;

    const ex = await client.query(
      `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, trigger_event_id, status, idempotency_key)
       VALUES ($1, $2, $3, $4, 'CREATED', $5) RETURNING *`,
      [workspaceId, args.workflowId, args.versionId, triggerEventId, args.idempotencyKey],
    );
    const execution = mapExecution(ex.rows[0] as Record<string, unknown>);
    for (const nodeId of args.nodeIds) {
      await client.query(
        `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt)
         VALUES ($1, $2, $3, 'PENDING', 1)`,
        [workspaceId, execution.id, nodeId],
      );
    }
    await insertOutbox(client, { eventType: 'execution.requested', payload: { executionId: execution.id } });
    await insertOutbox(client, {
      eventType: 'execution.watchdog',
      payload: { executionId: execution.id },
      delayMs: args.executionTimeoutMs,
    });
    await client.query(
      `INSERT INTO execution_events (workspace_id, execution_id, event_type, payload_json)
       VALUES ($1, $2, 'execution.created', $3)`,
      [workspaceId, execution.id, JSON.stringify({ idempotencyKey: args.idempotencyKey })],
    );
    return { outcome: 'created', execution };
  });
}

export async function casExecution(
  db: Db,
  args: {
    executionId: string;
    from: string[];
    to: string;
    startedAt?: boolean;
    completedAt?: boolean;
    errorSummary?: string;
  },
): Promise<boolean> {
  const sets = [`status = $1`];
  const params: unknown[] = [args.to, args.executionId, args.from];
  if (args.startedAt) sets.push(`started_at = now()`);
  if (args.completedAt) sets.push(`completed_at = now()`);
  if (args.errorSummary !== undefined) {
    params.push(args.errorSummary);
    sets.push(`error_summary = $${params.length}`);
  }
  const r = await db.query(`UPDATE executions SET ${sets.join(', ')} WHERE id = $2 AND status = ANY($3)`, params);
  return (r.rowCount ?? 0) > 0;
}

export interface NodePatch {
  inputJson?: unknown;
  outputJson?: unknown;
  outputPort?: string;
  errorJson?: unknown;
  startedAt?: boolean;
  completedAt?: boolean;
  workerId?: string;
}

export async function casNode(
  db: Db,
  args: { executionId: string; nodeId: string; attempt: number; from: string[]; to: string; patch?: NodePatch },
): Promise<boolean> {
  const p = args.patch ?? {};
  const sets = [`status = $1`];
  const params: unknown[] = [args.to, args.executionId, args.nodeId, args.attempt, args.from];
  const add = (expr: (i: number) => string, value: unknown) => {
    params.push(value);
    sets.push(expr(params.length));
  };
  if (p.inputJson !== undefined) add((i) => `input_json = $${i}`, capJson(p.inputJson));
  if (p.outputJson !== undefined) add((i) => `output_json = $${i}`, capJson(p.outputJson));
  if (p.outputPort !== undefined) add((i) => `output_port = $${i}`, p.outputPort);
  if (p.errorJson !== undefined) add((i) => `error_json = $${i}`, JSON.stringify(p.errorJson));
  if (p.workerId !== undefined) add((i) => `worker_id = $${i}`, p.workerId);
  if (p.startedAt) sets.push(`started_at = now()`);
  if (p.completedAt) sets.push(`completed_at = now()`);
  const r = await db.query(
    `UPDATE execution_nodes SET ${sets.join(', ')}
     WHERE execution_id = $2 AND node_id = $3 AND attempt = $4 AND status = ANY($5)`,
    params,
  );
  return (r.rowCount ?? 0) > 0;
}

export async function insertNodeAttempt(
  db: Db,
  args: { executionId: string; nodeId: string; attempt: number; status: string },
): Promise<void> {
  await db.query(
    `INSERT INTO execution_nodes (workspace_id, execution_id, node_id, status, attempt)
     SELECT e.workspace_id, e.id, $2, $3, $4 FROM executions e WHERE e.id = $1`,
    [args.executionId, args.nodeId, args.status, args.attempt],
  );
}

export async function latestNodeStates(
  db: Db,
  executionId: string,
): Promise<{ nodeId: string; status: string; attempt: number; outputPort: string | null }[]> {
  const r = await db.query(
    `SELECT DISTINCT ON (node_id) node_id, status, attempt, output_port
     FROM execution_nodes WHERE execution_id = $1 ORDER BY node_id, attempt DESC`,
    [executionId],
  );
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    nodeId: row['node_id'] as string,
    status: row['status'] as string,
    attempt: Number(row['attempt']),
    outputPort: (row['output_port'] as string | null) ?? null,
  }));
}

export async function succeededOutputs(db: Db, executionId: string): Promise<Record<string, unknown>> {
  const r = await db.query(
    `SELECT DISTINCT ON (node_id) node_id, status, output_json
     FROM execution_nodes WHERE execution_id = $1 ORDER BY node_id, attempt DESC`,
    [executionId],
  );
  const out: Record<string, unknown> = {};
  for (const row of r.rows as Record<string, unknown>[]) {
    if (row['status'] === 'SUCCEEDED') out[row['node_id'] as string] = row['output_json'];
  }
  return out;
}

export async function getTriggerPayload(db: Db, executionId: string): Promise<unknown> {
  const r = await db.query(
    `SELECT t.payload_json FROM executions e JOIN trigger_events t ON t.id = e.trigger_event_id WHERE e.id = $1`,
    [executionId],
  );
  return r.rowCount ? (r.rows[0] as { payload_json: unknown }).payload_json : null;
}

export async function appendEvent(
  db: Db,
  args: { executionId: string; eventType: string; nodeId?: string; payload?: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO execution_events (workspace_id, execution_id, event_type, node_id, payload_json)
     SELECT e.workspace_id, e.id, $2, $3, $4 FROM executions e WHERE e.id = $1`,
    [
      args.executionId,
      args.eventType,
      args.nodeId ?? null,
      args.payload === undefined ? null : JSON.stringify(args.payload),
    ],
  );
}

export interface NodeRow {
  nodeId: string;
  status: string;
  attempt: number;
  outputPort: string | null;
  errorJson: unknown;
  startedAt: string | null;
  completedAt: string | null;
}

export interface EventRow {
  sequence: number;
  eventType: string;
  nodeId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface WaitDetail {
  nodeId: string;
  kind: string;
  status: string;
  expiresAt: string | null;
  decision: string | null;
  resolvedBy: string | null;
}

export async function getExecutionDetail(
  pool: pg.Pool,
  id: string,
  workspaceId?: string,
): Promise<{ execution: ExecutionRow; nodes: NodeRow[]; events: EventRow[]; waits: WaitDetail[] } | null> {
  const ex = workspaceId
    ? await pool.query(`SELECT * FROM executions WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
    : await pool.query(`SELECT * FROM executions WHERE id = $1`, [id]);
  if (!ex.rowCount) return null;
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  const nodes = await pool.query(
    `SELECT node_id, status, attempt, output_port, error_json, started_at, completed_at
     FROM execution_nodes WHERE execution_id = $1 ORDER BY node_id, attempt`,
    [id],
  );
  const events = await pool.query(
    `SELECT sequence, event_type, node_id, payload_json, created_at
     FROM execution_events WHERE execution_id = $1 ORDER BY sequence`,
    [id],
  );
  // resume_token is intentionally NOT selected here — the API adds resumeUrl for
  // open event waits deliberately, and never exposes raw tokens for others.
  const waits = await pool.query(
    `SELECT node_id, kind, status, expires_at, decision, resolved_by
     FROM execution_waits WHERE execution_id = $1 ORDER BY created_at`,
    [id],
  );
  return {
    execution: mapExecution(ex.rows[0] as Record<string, unknown>),
    nodes: (nodes.rows as Record<string, unknown>[]).map((r) => ({
      nodeId: r['node_id'] as string,
      status: r['status'] as string,
      attempt: Number(r['attempt']),
      outputPort: (r['output_port'] as string | null) ?? null,
      errorJson: r['error_json'],
      startedAt: ts(r['started_at']),
      completedAt: ts(r['completed_at']),
    })),
    events: (events.rows as Record<string, unknown>[]).map((r) => ({
      sequence: Number(r['sequence']),
      eventType: r['event_type'] as string,
      nodeId: (r['node_id'] as string | null) ?? null,
      payload: r['payload_json'],
      createdAt: ts(r['created_at'])!,
    })),
    waits: (waits.rows as Record<string, unknown>[]).map((r) => ({
      nodeId: r['node_id'] as string,
      kind: r['kind'] as string,
      status: r['status'] as string,
      expiresAt: ts(r['expires_at']),
      decision: (r['decision'] as string | null) ?? null,
      resolvedBy: (r['resolved_by'] as string | null) ?? null,
    })),
  };
}

export async function listExecutions(
  db: Db,
  args: { workspaceId?: string; workflowId?: string; limit: number; cursor?: string },
): Promise<{ items: ExecutionRow[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (args.workspaceId) {
    params.push(args.workspaceId);
    where.push(`workspace_id = $${params.length}`);
  }
  if (args.workflowId) {
    params.push(args.workflowId);
    where.push(`workflow_id = $${params.length}`);
  }
  if (args.cursor) {
    const [createdAt, id] = Buffer.from(args.cursor, 'base64').toString('utf8').split('|');
    params.push(createdAt, id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(args.limit + 1);
  const r = await db.query(
    `SELECT * FROM executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows as Record<string, unknown>[];
  const hasMore = rows.length > args.limit;
  const items = rows.slice(0, args.limit);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(`${(last['created_at'] as Date).toISOString()}|${last['id'] as string}`).toString('base64')
      : null;
  return { items: items.map(mapExecution), nextCursor };
}
