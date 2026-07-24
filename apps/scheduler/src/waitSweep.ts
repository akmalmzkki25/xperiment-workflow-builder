import { applyResume, dueWaits, withTx, type WaitRow } from '@xperiment/db';
import { approvalFallbackOutcome, type ApprovalFallback } from '@xperiment/engine-core';
import type pg from 'pg';

const BATCH = 20;

export interface WaitSweepDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Resolves due waits: timers resume (SUCCEEDED), event waits that hit their
 * deadline fail (wait_timeout), and expired approvals apply their fallback.
 * A wait is "due" only via `resume_at` (timers) or `expires_at` (event/approval).
 */
export async function runWaitSweep(deps: WaitSweepDeps): Promise<{ resumed: number; expired: number }> {
  let resumed = 0;
  let expired = 0;

  await withTx(deps.pool, async (client) => {
    const due = await dueWaits(client, BATCH);
    // Isolate each wait with a savepoint so one bad row can't roll back the
    // whole batch's resumes while still holding the SKIP LOCKED locks.
    for (const wait of due) {
      await client.query('SAVEPOINT wait_item');
      try {
        const applied = await resolveDueWait(client, wait);
        await client.query('RELEASE SAVEPOINT wait_item');
        if (applied === 'resumed') resumed += 1;
        else if (applied === 'expired') expired += 1;
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT wait_item');
        deps.log('wait_sweep.item_failed', { waitId: wait.id, err: (e as Error).message });
      }
    }
  });

  if (resumed || expired) deps.log('wait_sweep.done', { resumed, expired });
  return { resumed, expired };
}

async function resolveDueWait(client: pg.PoolClient, wait: WaitRow): Promise<'resumed' | 'expired' | 'noop'> {
  const ref = { id: wait.id, executionId: wait.executionId, nodeId: wait.nodeId, attempt: wait.attempt };

  if (wait.kind === 'timer') {
    const ok = await applyResume(client, {
      wait: ref,
      waitStatus: 'resolved',
      terminal: 'SUCCEEDED',
      outputPort: 'main',
      output: { waited: true },
    });
    return ok ? 'resumed' : 'noop';
  }

  if (wait.kind === 'event') {
    const ok = await applyResume(client, {
      wait: ref,
      waitStatus: 'expired',
      terminal: 'FAILED',
      error: { code: 'wait_timeout', message: 'wait for event timed out' },
    });
    return ok ? 'expired' : 'noop';
  }

  // approval expiry → fallback
  const outcome = approvalFallbackOutcome((wait.fallback ?? 'fail') as ApprovalFallback);
  const ok = await applyResume(client, {
    wait: ref,
    waitStatus: 'expired',
    terminal: outcome.terminal,
    ...(outcome.outputPort ? { outputPort: outcome.outputPort } : {}),
    ...(outcome.terminal === 'SUCCEEDED'
      ? { output: { decision: wait.fallback, expired: true } }
      : { error: { code: 'approval_expired', message: 'approval expired without a decision' } }),
  });
  return ok ? 'expired' : 'noop';
}
