import { createHmac } from 'node:crypto';
import { assertUrlAllowed } from '@xperiment/connectors';
import { decryptSecret, getAlertWebhook, listAlertEvents } from '@xperiment/db';
import type pg from 'pg';

export interface AlertDeliveryDeps {
  pool: pg.Pool;
  alertKey: Buffer;
  allowPrivateIps: boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const TIMEOUT_MS = 10000;

/**
 * Delivers an alert firing to the rule's webhook: SSRF-checks the URL, then POSTs
 * a signed body. Throws on a non-2xx / blocked request so BullMQ retries. The
 * secret is never logged or sent — only the HMAC over the body is.
 */
export async function runAlertDelivery(
  deps: AlertDeliveryDeps,
  payload: { ruleId: string; eventId: string },
): Promise<void> {
  const cb = await getAlertWebhook(deps.pool, payload.ruleId);
  if (!cb) {
    deps.log('alert_delivery.no_webhook', { ruleId: payload.ruleId });
    return;
  }
  const ruleRow = await deps.pool.query(`SELECT workspace_id, name FROM alert_rules WHERE id=$1`, [payload.ruleId]);
  if (!ruleRow.rowCount) {
    deps.log('alert_delivery.unknown_rule', { ruleId: payload.ruleId });
    return;
  }
  const rule = ruleRow.rows[0] as { workspace_id: string; name: string };
  const events = await listAlertEvents(deps.pool, rule.workspace_id, 200);
  const event = events.find((e) => e.id === payload.eventId);
  if (!event) {
    deps.log('alert_delivery.unknown_event', { eventId: payload.eventId });
    return;
  }

  await assertUrlAllowed(cb.url, { allowPrivate: deps.allowPrivateIps });

  const body = JSON.stringify({
    ruleId: payload.ruleId,
    ruleName: rule.name,
    workspaceId: rule.workspace_id,
    firedAt: event.firedAt,
    detail: event.detail,
  });
  const secret = decryptSecret(cb.secretEncrypted, deps.alertKey);
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  const res = await fetch(cb.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xperiment-signature': signature },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`alert webhook returned ${res.status}`);
  deps.log('alert_delivery.delivered', { ruleId: payload.ruleId, status: res.status });
}
