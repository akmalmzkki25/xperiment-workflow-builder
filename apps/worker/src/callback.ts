import { createHmac } from 'node:crypto';
import { assertUrlAllowed } from '@xperiment/connectors';
import { decryptSecret, getExecutionDetail, getWorkflowCallback } from '@xperiment/db';
import type pg from 'pg';

export interface CallbackDeps {
  pool: pg.Pool;
  triggerKey: Buffer;
  allowPrivateIps: boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const TIMEOUT_MS = 10000;

/**
 * Delivers an execution-completion webhook: loads the workflow's callback URL +
 * secret, SSRF-checks the URL, then POSTs a signed body. Throws on a non-2xx or a
 * blocked/failed request so BullMQ retries. The secret is never logged or sent —
 * only the HMAC over the body is.
 */
export async function runCallback(deps: CallbackDeps, payload: { executionId: string }): Promise<void> {
  const detail = await getExecutionDetail(deps.pool, payload.executionId);
  if (!detail) {
    deps.log('callback.unknown_execution', { executionId: payload.executionId });
    return;
  }
  const cb = await getWorkflowCallback(deps.pool, detail.execution.workflowId);
  if (!cb) {
    deps.log('callback.not_configured', { executionId: payload.executionId });
    return; // callback was cleared after the event was enqueued — nothing to do
  }

  await assertUrlAllowed(cb.url, { allowPrivate: deps.allowPrivateIps }); // SSRF guard (throws → BullMQ retries/drops)

  const body = JSON.stringify({
    executionId: detail.execution.id,
    workflowId: detail.execution.workflowId,
    status: detail.execution.status,
    completedAt: detail.execution.completedAt,
  });
  const secret = decryptSecret(cb.secretEncrypted, deps.triggerKey);
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  const res = await fetch(cb.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xperiment-signature': signature },
    body,
    redirect: 'error', // never follow a redirect to an unvalidated host (SSRF hop)
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Do not include the response body — it is a third-party surface.
    throw new Error(`callback returned ${res.status}`);
  }
  deps.log('callback.delivered', { executionId: payload.executionId, status: res.status });
}
