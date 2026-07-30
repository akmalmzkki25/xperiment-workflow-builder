import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { type Db } from '../pool.js';

export interface TriggerRow {
  id: string;
  /** Required by the vault to decrypt secretEncrypted. */
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  type: 'webhook' | 'schedule';
  routeKey: string;
  authMode: string | null;
  idempotencyKeyPath: string | null;
  cron: string | null;
  timezone: string | null;
  nextFireAt: string | null;
  active: boolean;
  secretEncrypted: Buffer | null;
  secretEncVersion: number;
}

function mapTrigger(r: Record<string, unknown>): TriggerRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    workflowId: r['workflow_id'] as string,
    nodeId: r['node_id'] as string,
    type: r['type'] as 'webhook' | 'schedule',
    routeKey: r['route_key'] as string,
    authMode: (r['auth_mode'] as string | null) ?? null,
    idempotencyKeyPath: (r['idempotency_key_path'] as string | null) ?? null,
    cron: (r['cron'] as string | null) ?? null,
    timezone: (r['timezone'] as string | null) ?? null,
    nextFireAt: ts(r['next_fire_at']),
    active: r['active'] as boolean,
    secretEncrypted: (r['secret_encrypted'] as Buffer | null) ?? null,
    secretEncVersion: (r['secret_enc_version'] as number | null) ?? 0,
  };
}

export async function upsertTrigger(
  db: Db,
  args: {
    workflowId: string;
    nodeId: string;
    type: 'webhook' | 'schedule';
    authMode?: string;
    idempotencyKeyPath?: string;
    cron?: string;
    timezone?: string;
    nextFireAt?: Date | null;
    secretEncrypted?: Buffer | null;
    secretEncVersion?: number;
  },
): Promise<TriggerRow> {
  const routeKey = randomBytes(24).toString('base64url');
  const r = await db.query(
    `INSERT INTO workflow_triggers
       (workspace_id, workflow_id, node_id, type, route_key, auth_mode, secret_encrypted, secret_enc_version,
        idempotency_key_path, cron, timezone, next_fire_at)
     SELECT w.workspace_id, w.id, $2, $3, $4, $5, $6, COALESCE($11, 0), $7, $8, $9, $10
       FROM workflows w WHERE w.id = $1
     ON CONFLICT (workflow_id, node_id) DO UPDATE SET
       type = EXCLUDED.type,
       auth_mode = EXCLUDED.auth_mode,
       secret_encrypted = COALESCE(workflow_triggers.secret_encrypted, EXCLUDED.secret_encrypted),
       -- Must move with the blob above, not independently: relabelling a retained v1
       -- secret as v0 would make it permanently unreadable. Verified by replacing this
       -- with a plain EXCLUDED - the lockstep test then fails with 0 where 1 is expected.
       secret_enc_version = CASE
         WHEN workflow_triggers.secret_encrypted IS NULL THEN EXCLUDED.secret_enc_version
         ELSE workflow_triggers.secret_enc_version
       END,
       idempotency_key_path = EXCLUDED.idempotency_key_path,
       cron = EXCLUDED.cron,
       timezone = EXCLUDED.timezone,
       next_fire_at = EXCLUDED.next_fire_at,
       updated_at = now()
     RETURNING *`,
    [
      args.workflowId,
      args.nodeId,
      args.type,
      routeKey,
      args.authMode ?? null,
      args.secretEncrypted ?? null,
      args.idempotencyKeyPath ?? null,
      args.cron ?? null,
      args.timezone ?? null,
      args.nextFireAt ?? null,
      args.secretEncVersion ?? null,
    ],
  );
  return mapTrigger(r.rows[0] as Record<string, unknown>);
}

export async function getTriggerByRouteKey(db: Db, routeKey: string): Promise<TriggerRow | null> {
  const r = await db.query(`SELECT * FROM workflow_triggers WHERE route_key = $1`, [routeKey]);
  return r.rowCount ? mapTrigger(r.rows[0] as Record<string, unknown>) : null;
}

export async function listTriggers(db: Db, workflowId: string): Promise<TriggerRow[]> {
  const r = await db.query(`SELECT * FROM workflow_triggers WHERE workflow_id = $1 ORDER BY node_id`, [workflowId]);
  return (r.rows as Record<string, unknown>[]).map(mapTrigger);
}

export async function setTriggersActive(db: Db, workflowId: string, active: boolean): Promise<void> {
  await db.query(`UPDATE workflow_triggers SET active = $1, updated_at = now() WHERE workflow_id = $2`, [
    active,
    workflowId,
  ]);
}

export async function setWorkflowActive(db: Db, workflowId: string, active: boolean): Promise<void> {
  await db.query(`UPDATE workflows SET active = $1, updated_at = now() WHERE id = $2`, [active, workflowId]);
}

export async function deleteTriggersNotIn(db: Db, workflowId: string, nodeIds: string[]): Promise<void> {
  await db.query(`DELETE FROM workflow_triggers WHERE workflow_id = $1 AND NOT (node_id = ANY($2))`, [
    workflowId,
    nodeIds,
  ]);
}

export async function dueScheduleTriggers(client: pg.PoolClient, limit: number): Promise<TriggerRow[]> {
  const r = await client.query(
    `SELECT * FROM workflow_triggers
     WHERE type = 'schedule' AND active AND next_fire_at <= now()
     ORDER BY next_fire_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Record<string, unknown>[]).map(mapTrigger);
}

export async function updateNextFireAt(db: Db, triggerId: string, nextFireAt: Date): Promise<void> {
  await db.query(`UPDATE workflow_triggers SET next_fire_at = $1, updated_at = now() WHERE id = $2`, [
    nextFireAt,
    triggerId,
  ]);
}

export async function recentTestTriggerPayloads(db: Db, workflowId: string, limit: number): Promise<unknown[]> {
  const r = await db.query(
    `SELECT t.payload_json FROM trigger_events t
     JOIN executions e ON e.trigger_event_id = t.id
     WHERE t.workflow_id = $1 AND e.mode = 'test'
     ORDER BY t.received_at DESC
     LIMIT $2`,
    [workflowId, limit],
  );
  return (r.rows as { payload_json: unknown }[]).map((row) => row.payload_json);
}
