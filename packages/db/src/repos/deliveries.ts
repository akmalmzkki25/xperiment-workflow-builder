import { type Db } from '../pool.js';

/**
 * Every inbound webhook delivery to a KNOWN route key, accepted or not.
 *
 * "Known" is load-bearing. An unrecognised route key writes nothing, because otherwise
 * anyone could fill this table by spraying random keys at the gateway — unauthenticated
 * write amplification, from a public endpoint.
 */

export type DeliveryOutcome =
  | 'accepted'
  | 'duplicate'
  | 'unauthorized'
  | 'inactive'
  | 'invalid_json'
  | 'too_large'
  | 'quota_exceeded';

export interface DeliveryRow {
  id: string;
  workflowId: string;
  nodeId: string;
  mode: string;
  outcome: string;
  statusCode: number;
  authMode: string | null;
  headersSeen: string[];
  bodyBytes: number;
  executionId: string | null;
  receivedAt: string;
}

/**
 * Header names worth recording, as a fixed allowlist.
 *
 * Recording every name that arrived would leak the caller's proxy chain and bury the one
 * fact that matters. These are exactly the headers a signature scheme is carried in, so
 * the panel can say "you sent this, the trigger expects that".
 */
export const DIAGNOSTIC_HEADERS: readonly string[] = [
  'authorization',
  'x-xperiment-signature',
  'x-hub-signature-256',
  'x-callback-token',
  'idempotency-key',
];

/** Which diagnostic headers were present. NAMES only — the values are the secrets. */
export function headersSeen(headers: Record<string, unknown>): string[] {
  const present = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  return DIAGNOSTIC_HEADERS.filter((name) => present.has(name));
}

export interface RecordDeliveryArgs {
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  nodeId: string;
  mode: string;
  outcome: DeliveryOutcome;
  statusCode: number;
  authMode: string | null;
  headersSeen: readonly string[];
  bodyBytes: number;
  executionId?: string | null;
}

export async function recordDelivery(db: Db, args: RecordDeliveryArgs): Promise<void> {
  await db.query(
    `INSERT INTO webhook_deliveries
       (workspace_id, workflow_id, trigger_id, node_id, mode, outcome, status_code, auth_mode,
        headers_seen, body_bytes, execution_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      args.workspaceId,
      args.workflowId,
      args.triggerId,
      args.nodeId,
      args.mode,
      args.outcome,
      args.statusCode,
      args.authMode,
      args.headersSeen,
      args.bodyBytes,
      args.executionId ?? null,
    ],
  );
}

function mapDelivery(r: Record<string, unknown>): DeliveryRow {
  const ts = (v: unknown): string => (v instanceof Date ? v.toISOString() : (v as string));
  return {
    id: r['id'] as string,
    workflowId: r['workflow_id'] as string,
    nodeId: r['node_id'] as string,
    mode: r['mode'] as string,
    outcome: r['outcome'] as string,
    statusCode: Number(r['status_code']),
    authMode: (r['auth_mode'] as string | null) ?? null,
    headersSeen: (r['headers_seen'] as string[] | null) ?? [],
    bodyBytes: Number(r['body_bytes']),
    executionId: (r['execution_id'] as string | null) ?? null,
    receivedAt: ts(r['received_at']),
  };
}

/** `workspaceId` is required for the same reason every other read here requires it. */
export async function listDeliveries(
  db: Db,
  args: { workspaceId: string; workflowId: string; nodeId?: string | undefined; limit: number },
): Promise<DeliveryRow[]> {
  const params: unknown[] = [args.workspaceId, args.workflowId];
  let where = `workspace_id = $1 AND workflow_id = $2`;
  if (args.nodeId !== undefined) {
    params.push(args.nodeId);
    where += ` AND node_id = $${params.length}`;
  }
  params.push(args.limit);
  const r = await db.query(
    `SELECT * FROM webhook_deliveries WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return (r.rows as Record<string, unknown>[]).map(mapDelivery);
}
