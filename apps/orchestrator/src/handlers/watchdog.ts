import { appendEvent, casExecution, casNode, latestNodeStates, waitsForExecution, withTx } from '@xperiment/db';
import type { WatchdogPayload } from '@xperiment/queue';
import { loadExecutionContext, TERMINAL_EXECUTION_STATUSES, type OrchestratorDeps } from '../deps.js';

const TIMEOUT_ERROR = { code: 'execution_timeout', message: 'Execution exceeded its timeout', retryable: false };

export async function handleWatchdog(deps: OrchestratorDeps, payload: WatchdogPayload): Promise<void> {
  const ctx = await loadExecutionContext(deps.pool, payload.executionId);
  if (!ctx) {
    deps.log('watchdog.unknown_execution', { executionId: payload.executionId });
    return;
  }
  if (TERMINAL_EXECUTION_STATUSES.includes(ctx.execution.status)) return;
  const { executionId } = payload;

  // A legitimately-suspended execution is not stalled: an open wait bounds itself
  // via its own expires_at (swept by the scheduler), so the global watchdog skips it.
  const waits = await waitsForExecution(deps.pool, executionId);
  if (waits.some((w) => w.status === 'open')) {
    deps.log('watchdog.skipped_open_wait', { executionId });
    return;
  }

  await withTx(deps.pool, async (client) => {
    const states = await latestNodeStates(client, executionId);
    for (const s of states) {
      if (['PENDING', 'READY', 'QUEUED', 'RUNNING'].includes(s.status)) {
        const ok = await casNode(client, {
          executionId,
          nodeId: s.nodeId,
          attempt: s.attempt,
          from: ['PENDING', 'READY', 'QUEUED', 'RUNNING'],
          to: 'FAILED',
          patch: { errorJson: TIMEOUT_ERROR, completedAt: true },
        });
        if (ok) {
          await appendEvent(client, {
            executionId,
            eventType: 'node.failed',
            nodeId: s.nodeId,
            payload: TIMEOUT_ERROR,
          });
        }
      }
    }
    const timedOut = await casExecution(client, {
      executionId,
      from: ['QUEUED', 'RUNNING'],
      to: 'TIMED_OUT',
      completedAt: true,
      errorSummary: 'Execution timed out',
    });
    if (timedOut) await appendEvent(client, { executionId, eventType: 'execution.timed_out' });
  });
}
