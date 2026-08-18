import { billingPeriod, BILLING_TZ } from '@xperiment/plans';
import { type Db } from '../pool.js';
import { incrementUsageCounter } from './entitlements.js';

export type UsageMetric = 'execution' | 'node' | 'compute_ms' | 'ai_tokens';

export interface UsageEventInput {
  workspaceId: string;
  metric: UsageMetric;
  quantity: number;
  executionId?: string;
  workflowId?: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

/** Append rows to the immutable usage ledger. No-op on an empty batch. */
export async function insertUsageEvents(db: Db, events: UsageEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  for (const e of events) {
    const b = params.length;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
    params.push(
      e.workspaceId,
      e.metric,
      e.quantity,
      e.executionId ?? null,
      e.workflowId ?? null,
      JSON.stringify(e.metadata ?? {}),
      e.occurredAt.toISOString(),
    );
  }
  await db.query(
    `INSERT INTO usage_events (workspace_id, metric, quantity, execution_id, workflow_id, metadata, occurred_at)
     VALUES ${values.join(',')}`,
    params,
  );
}

export interface RecordExecutionUsageArgs {
  workspaceId: string;
  workflowId: string;
  executionId: string;
  status: string;
  nodeCount: number;
  computeMs: number;
  occurredAt: Date;
}

/** Emit the standard row-set for a finalized execution (0-quantity node/compute rows omitted). */
export async function recordExecutionUsage(db: Db, args: RecordExecutionUsageArgs): Promise<void> {
  const base = {
    workspaceId: args.workspaceId,
    workflowId: args.workflowId,
    executionId: args.executionId,
    occurredAt: args.occurredAt,
  };
  const events: UsageEventInput[] = [{ ...base, metric: 'execution', quantity: 1, metadata: { status: args.status } }];
  if (args.nodeCount > 0) events.push({ ...base, metric: 'node', quantity: args.nodeCount });
  if (args.computeMs > 0) events.push({ ...base, metric: 'compute_ms', quantity: args.computeMs });
  await insertUsageEvents(db, events);
}

/** Record AI token usage for one generation call. Skips a zero/negative count. */
export async function recordAiUsage(
  db: Db,
  args: { workspaceId: string; tokens: number; model: string; kind: string },
): Promise<void> {
  if (args.tokens <= 0) return;
  await insertUsageEvents(db, [
    {
      workspaceId: args.workspaceId,
      metric: 'ai_tokens',
      quantity: args.tokens,
      metadata: { model: args.model, kind: args.kind },
      occurredAt: new Date(),
    },
  ]);
  // The ledger is the billing truth; the counter is the O(1) index quota reads.
  await incrementUsageCounter(db, {
    workspaceId: args.workspaceId,
    periodKey: billingPeriod(new Date()).key,
    metric: 'ai_tokens',
    quantity: args.tokens,
  });
}

export interface UsageSummary {
  period: { from: string; to: string };
  totals: { executions: number; succeeded: number; failed: number; nodes: number; computeMs: number; aiTokens: number };
  series: { date: string; executions: number; nodes: number; computeMs: number; aiTokens: number }[];
}

export async function getUsageSummary(
  db: Db,
  args: { workspaceId: string; from: Date; to: Date },
): Promise<UsageSummary> {
  const params = [args.workspaceId, args.from.toISOString(), args.to.toISOString()];
  const totalsRes = await db.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution'),0)::bigint AS executions,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution' AND metadata->>'status'='SUCCEEDED'),0)::bigint AS succeeded,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution' AND metadata->>'status'='FAILED'),0)::bigint AS failed,
       COALESCE(SUM(quantity) FILTER (WHERE metric='node'),0)::bigint AS nodes,
       COALESCE(SUM(quantity) FILTER (WHERE metric='compute_ms'),0)::bigint AS compute_ms,
       COALESCE(SUM(quantity) FILTER (WHERE metric='ai_tokens'),0)::bigint AS ai_tokens
     FROM usage_events WHERE workspace_id=$1 AND occurred_at >= $2 AND occurred_at < $3`,
    params,
  );
  const seriesRes = await db.query(
    `SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE $4), 'YYYY-MM-DD') AS date,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution'),0)::bigint AS executions,
       COALESCE(SUM(quantity) FILTER (WHERE metric='node'),0)::bigint AS nodes,
       COALESCE(SUM(quantity) FILTER (WHERE metric='compute_ms'),0)::bigint AS compute_ms,
       COALESCE(SUM(quantity) FILTER (WHERE metric='ai_tokens'),0)::bigint AS ai_tokens
     FROM usage_events WHERE workspace_id=$1 AND occurred_at >= $2 AND occurred_at < $3
     GROUP BY 1 ORDER BY 1`,
    // A shop owner reading a bar per day must see their own days, not UTC's.
    [...params, BILLING_TZ],
  );
  const t = totalsRes.rows[0] as Record<string, string>;
  const n = (v: string | undefined): number => Number(v ?? 0);
  return {
    period: { from: args.from.toISOString(), to: args.to.toISOString() },
    totals: {
      executions: n(t['executions']),
      succeeded: n(t['succeeded']),
      failed: n(t['failed']),
      nodes: n(t['nodes']),
      computeMs: n(t['compute_ms']),
      aiTokens: n(t['ai_tokens']),
    },
    series: (seriesRes.rows as Record<string, string>[]).map((r) => ({
      date: r['date']!,
      executions: n(r['executions']),
      nodes: n(r['nodes']),
      computeMs: n(r['compute_ms']),
      aiTokens: n(r['ai_tokens']),
    })),
  };
}
