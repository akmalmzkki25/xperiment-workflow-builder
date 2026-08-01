import { type Db } from '../pool.js';

export const AUDIT_PAGE_MAX = 200;

export type ActorKind = 'user' | 'api_key' | 'system' | 'anonymous';

/**
 * Scalars only, on purpose. A request body, a connector payload or a provider response
 * may carry a secret, so spreading one into an audit row must not typecheck. Build
 * metadata field by field at the call site.
 */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/**
 * Who did it, and from where. Split out of AuditEventInput so a repository function can
 * accept the actor without also accepting the action — and so apps/api's auditActor(req)
 * has one authoritative shape to return rather than a structurally-similar literal.
 */
export interface AuditActor {
  actorKind: ActorKind;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  /** Email for an anonymous attempt, or a retained label once the user row is gone. */
  actorLabel?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEventInput extends AuditActor {
  workspaceId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'failure';
  metadata?: AuditMetadata;
}

export interface AuditEventRow {
  /** BIGSERIAL: node-postgres returns int8 as a string, and it is the page cursor. */
  id: string;
  workspaceId: string | null;
  actorKind: ActorKind;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
  /**
   * Resolved on read rather than denormalised on write — no per-request lookup, and no
   * need to widen AuthContext with an email. Null once the user row is gone, which is
   * what actorLabel exists to cover.
   */
  actorEmail: string | null;
  actorApiKeyName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'failure';
  metadata: AuditMetadata;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

function mapEvent(r: Record<string, unknown>): AuditEventRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
  return {
    id: String(r['id']),
    workspaceId: (r['workspace_id'] as string | null) ?? null,
    actorKind: r['actor_kind'] as ActorKind,
    actorUserId: (r['actor_user_id'] as string | null) ?? null,
    actorApiKeyId: (r['actor_api_key_id'] as string | null) ?? null,
    actorLabel: (r['actor_label'] as string | null) ?? null,
    actorEmail: (r['actor_email'] as string | null) ?? null,
    actorApiKeyName: (r['actor_api_key_name'] as string | null) ?? null,
    action: r['action'] as string,
    targetType: (r['target_type'] as string | null) ?? null,
    targetId: (r['target_id'] as string | null) ?? null,
    outcome: r['outcome'] as 'success' | 'failure',
    metadata: (r['metadata'] as AuditMetadata | null) ?? {},
    requestId: (r['request_id'] as string | null) ?? null,
    ip: (r['ip'] as string | null) ?? null,
    userAgent: (r['user_agent'] as string | null) ?? null,
    createdAt: ts(r['created_at']),
  };
}

/**
 * Pass a transaction client when the event describes a mutation, so the row commits or
 * rolls back with it. Pass the pool for events that mutate nothing — a credential
 * read-use, a failed login.
 */
export async function appendAuditEvent(db: Db, input: AuditEventInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (workspace_id, actor_kind, actor_user_id, actor_api_key_id, actor_label,
        action, target_type, target_id, outcome, metadata, request_id, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'success'),COALESCE($10::jsonb,'{}'::jsonb),$11,$12,$13)`,
    [
      input.workspaceId ?? null,
      input.actorKind,
      input.actorUserId ?? null,
      input.actorApiKeyId ?? null,
      input.actorLabel ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.outcome ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.requestId ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
}

/**
 * Ordered and paginated on `id`, not `created_at`. created_at is now(), which is
 * transaction start time, so a long transaction can commit a row with an earlier
 * timestamp than one already visible — and ties on a timestamp make the order
 * nondeterministic. BIGSERIAL is monotonic in insert order.
 *
 * Rows with workspace_id IS NULL are global (a failed login for an unknown email) and
 * are never returned here.
 */
export async function listAuditEvents(
  db: Db,
  args: {
    workspaceId: string;
    limit: number;
    before?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
  },
): Promise<AuditEventRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(args.limit)), AUDIT_PAGE_MAX);
  const r = await db.query(
    `SELECT a.*, u.email AS actor_email, k.name AS actor_api_key_name
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       -- Keyed on id AND workspace: a cross-workspace id must not surface another
       -- tenant's key name.
       LEFT JOIN api_keys k ON k.id = a.actor_api_key_id AND k.workspace_id = a.workspace_id
      WHERE a.workspace_id = $1
        AND ($2::bigint IS NULL OR a.id < $2::bigint)
        AND ($3::text IS NULL OR a.action = $3)
        AND ($4::text IS NULL OR a.target_type = $4)
        AND ($5::text IS NULL OR a.target_id = $5)
      ORDER BY a.id DESC
      LIMIT $6`,
    [args.workspaceId, args.before ?? null, args.action ?? null, args.targetType ?? null, args.targetId ?? null, limit],
  );
  return (r.rows as Record<string, unknown>[]).map(mapEvent);
}
