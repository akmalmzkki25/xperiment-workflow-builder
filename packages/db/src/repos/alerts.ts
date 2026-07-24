import { type Db } from '../pool.js';
import { insertOutbox } from './outbox.js';

export type AlertType = 'failure_rate' | 'usage_threshold';

export interface AlertRuleRow {
  id: string;
  workspaceId: string;
  name: string;
  type: AlertType;
  params: Record<string, unknown>;
  webhookUrl: string | null;
  enabled: boolean;
  cooldownMinutes: number;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface AlertEventRow {
  id: string;
  workspaceId: string;
  ruleId: string;
  firedAt: string;
  detail: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
}

const ts = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (v as string | null));

function mapRule(r: Record<string, unknown>): AlertRuleRow {
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    name: r['name'] as string,
    type: r['type'] as AlertType,
    params: (r['params'] as Record<string, unknown>) ?? {},
    webhookUrl: (r['webhook_url'] as string | null) ?? null,
    enabled: r['enabled'] as boolean,
    cooldownMinutes: Number(r['cooldown_minutes']),
    lastFiredAt: ts(r['last_fired_at']),
    createdAt: ts(r['created_at'])!,
  };
}

function mapEvent(r: Record<string, unknown>): AlertEventRow {
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    ruleId: r['rule_id'] as string,
    firedAt: ts(r['fired_at'])!,
    detail: (r['detail'] as Record<string, unknown>) ?? {},
    acknowledgedAt: ts(r['acknowledged_at']),
    createdAt: ts(r['created_at'])!,
  };
}

export async function createAlertRule(
  db: Db,
  args: {
    workspaceId: string;
    name: string;
    type: AlertType;
    params: Record<string, unknown>;
    webhookUrl?: string;
    webhookSecretEncrypted?: Buffer;
    cooldownMinutes?: number;
  },
): Promise<AlertRuleRow> {
  const r = await db.query(
    `INSERT INTO alert_rules (workspace_id, name, type, params, webhook_url, webhook_secret_encrypted, cooldown_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,60)) RETURNING *`,
    [
      args.workspaceId,
      args.name,
      args.type,
      JSON.stringify(args.params),
      args.webhookUrl ?? null,
      args.webhookSecretEncrypted ?? null,
      args.cooldownMinutes ?? null,
    ],
  );
  return mapRule(r.rows[0] as Record<string, unknown>);
}

export async function listAlertRules(db: Db, workspaceId: string): Promise<AlertRuleRow[]> {
  const r = await db.query(`SELECT * FROM alert_rules WHERE workspace_id=$1 ORDER BY created_at DESC`, [workspaceId]);
  return (r.rows as Record<string, unknown>[]).map(mapRule);
}

export async function getAlertRule(db: Db, id: string, workspaceId: string): Promise<AlertRuleRow | null> {
  const r = await db.query(`SELECT * FROM alert_rules WHERE id=$1 AND workspace_id=$2`, [id, workspaceId]);
  return r.rowCount ? mapRule(r.rows[0] as Record<string, unknown>) : null;
}

export async function updateAlertRule(
  db: Db,
  id: string,
  workspaceId: string,
  patch: { name?: string; params?: Record<string, unknown>; enabled?: boolean; cooldownMinutes?: number },
): Promise<AlertRuleRow | null> {
  const r = await db.query(
    `UPDATE alert_rules SET
       name = COALESCE($3, name),
       params = COALESCE($4, params),
       enabled = COALESCE($5, enabled),
       cooldown_minutes = COALESCE($6, cooldown_minutes)
     WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [
      id,
      workspaceId,
      patch.name ?? null,
      patch.params ? JSON.stringify(patch.params) : null,
      patch.enabled ?? null,
      patch.cooldownMinutes ?? null,
    ],
  );
  return r.rowCount ? mapRule(r.rows[0] as Record<string, unknown>) : null;
}

export async function deleteAlertRule(db: Db, id: string, workspaceId: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM alert_rules WHERE id=$1 AND workspace_id=$2`, [id, workspaceId]);
  return (r.rowCount ?? 0) > 0;
}

export async function dueAlertRules(client: Db): Promise<AlertRuleRow[]> {
  const r = await client.query(
    `SELECT * FROM alert_rules
     WHERE enabled AND (last_fired_at IS NULL OR last_fired_at < now() - make_interval(mins => cooldown_minutes))
     FOR UPDATE SKIP LOCKED`,
  );
  return (r.rows as Record<string, unknown>[]).map(mapRule);
}

export async function evaluateFailureRate(
  db: Db,
  args: { workspaceId: string; windowStart: Date },
): Promise<{ total: number; failed: number }> {
  const r = await db.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution'),0)::bigint AS total,
       COALESCE(SUM(quantity) FILTER (WHERE metric='execution' AND metadata->>'status'='FAILED'),0)::bigint AS failed
     FROM usage_events WHERE workspace_id=$1 AND occurred_at >= $2`,
    [args.workspaceId, args.windowStart.toISOString()],
  );
  const row = r.rows[0] as { total: string; failed: string };
  return { total: Number(row.total), failed: Number(row.failed) };
}

export async function evaluateUsageMetric(
  db: Db,
  args: { workspaceId: string; metric: string; windowStart: Date },
): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(quantity),0)::bigint AS observed FROM usage_events
     WHERE workspace_id=$1 AND metric=$2 AND occurred_at >= $3`,
    [args.workspaceId, args.metric, args.windowStart.toISOString()],
  );
  return Number((r.rows[0] as { observed: string }).observed);
}

export async function fireAlert(
  client: Db,
  args: { rule: AlertRuleRow; detail: Record<string, unknown>; firedAt: Date },
): Promise<AlertEventRow> {
  const ev = await client.query(
    `INSERT INTO alert_events (workspace_id, rule_id, fired_at, detail) VALUES ($1,$2,$3,$4) RETURNING *`,
    [args.rule.workspaceId, args.rule.id, args.firedAt.toISOString(), JSON.stringify(args.detail)],
  );
  const event = mapEvent(ev.rows[0] as Record<string, unknown>);
  await client.query(`UPDATE alert_rules SET last_fired_at=$2 WHERE id=$1`, [args.rule.id, args.firedAt.toISOString()]);
  if (args.rule.webhookUrl) {
    await insertOutbox(client, { eventType: 'alert.notify', payload: { ruleId: args.rule.id, eventId: event.id } });
  }
  return event;
}

export async function listAlertEvents(db: Db, workspaceId: string, limit: number): Promise<AlertEventRow[]> {
  const r = await db.query(`SELECT * FROM alert_events WHERE workspace_id=$1 ORDER BY fired_at DESC LIMIT $2`, [
    workspaceId,
    Math.min(Math.max(limit, 1), 200),
  ]);
  return (r.rows as Record<string, unknown>[]).map(mapEvent);
}

export async function getAlertEventById(db: Db, id: string): Promise<AlertEventRow | null> {
  const r = await db.query(`SELECT * FROM alert_events WHERE id=$1`, [id]);
  return r.rowCount ? mapEvent(r.rows[0] as Record<string, unknown>) : null;
}

export async function countUnacknowledgedAlerts(db: Db, workspaceId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM alert_events WHERE workspace_id=$1 AND acknowledged_at IS NULL`,
    [workspaceId],
  );
  return Number((r.rows[0] as { c: number }).c);
}

export async function acknowledgeAlert(db: Db, id: string, workspaceId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE alert_events SET acknowledged_at=now() WHERE id=$1 AND workspace_id=$2 AND acknowledged_at IS NULL`,
    [id, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getAlertWebhook(
  db: Db,
  ruleId: string,
): Promise<{ url: string; secretEncrypted: Buffer } | null> {
  const r = await db.query(
    `SELECT webhook_url, webhook_secret_encrypted FROM alert_rules
     WHERE id=$1 AND webhook_url IS NOT NULL AND webhook_secret_encrypted IS NOT NULL`,
    [ruleId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { webhook_url: string; webhook_secret_encrypted: Buffer };
  return { url: row.webhook_url, secretEncrypted: row.webhook_secret_encrypted };
}
