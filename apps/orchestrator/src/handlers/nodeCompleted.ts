import {
  appendEvent,
  casExecution,
  casNode,
  insertNodeAttempt,
  insertOutbox,
  latestNodeStates,
  withTx,
} from '@xperiment/db';
import { computeReadiness, type NodeOutcome, type NodeStatus } from '@xperiment/engine-core';
import type { NodeCompletedPayload } from '@xperiment/queue';
import { loadExecutionContext, TERMINAL_EXECUTION_STATUSES, type OrchestratorDeps } from '../deps.js';

export async function handleNodeCompleted(deps: OrchestratorDeps, payload: NodeCompletedPayload): Promise<void> {
  const ctx = await loadExecutionContext(deps.pool, payload.executionId);
  if (!ctx) {
    deps.log('node_completed.unknown_execution', { executionId: payload.executionId });
    return;
  }
  if (TERMINAL_EXECUTION_STATUSES.includes(ctx.execution.status)) {
    deps.log('node_completed.execution_terminal', { executionId: payload.executionId });
    return;
  }
  const { executionId, nodeId } = payload;

  if (payload.status === 'RETRY_SCHEDULED') {
    const nextAttempt = payload.attempt + 1;
    try {
      await withTx(deps.pool, async (client) => {
        await insertNodeAttempt(client, { executionId, nodeId, attempt: nextAttempt, status: 'QUEUED' });
        await appendEvent(client, {
          executionId,
          eventType: 'node.retry_scheduled',
          nodeId,
          payload: { attempt: nextAttempt, delayMs: payload.delayMs ?? 0 },
        });
        await insertOutbox(client, {
          eventType: 'node.task',
          payload: { executionId, nodeId, attempt: nextAttempt },
          delayMs: payload.delayMs ?? 0,
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        deps.log('node_completed.retry_duplicate', { executionId, nodeId, attempt: nextAttempt });
        return;
      }
      throw e;
    }
    return;
  }

  if (payload.status === 'FAILED') {
    await withTx(deps.pool, async (client) => {
      const states = await latestNodeStates(client, executionId);
      for (const s of states) {
        if (s.status === 'PENDING') {
          await casNode(client, {
            executionId,
            nodeId: s.nodeId,
            attempt: s.attempt,
            from: ['PENDING'],
            to: 'SKIPPED',
          });
          await appendEvent(client, { executionId, eventType: 'node.skipped', nodeId: s.nodeId });
        }
      }
      const failed = await casExecution(client, {
        executionId,
        from: ['RUNNING'],
        to: 'FAILED',
        completedAt: true,
        errorSummary: `Node '${nodeId}' failed`,
      });
      if (failed) await appendEvent(client, { executionId, eventType: 'execution.failed', nodeId });
    });
    return;
  }

  // SUCCEEDED
  await withTx(deps.pool, async (client) => {
    const states = await latestNodeStates(client, executionId);
    const outcomes: NodeOutcome[] = states.map((s) => ({
      nodeId: s.nodeId,
      status: s.status as NodeStatus,
      outputPort: s.outputPort,
    }));
    const readiness = computeReadiness(ctx.ir, outcomes);

    for (const skippedId of readiness.skipped) {
      const ok = await casNode(client, {
        executionId,
        nodeId: skippedId,
        attempt: 1,
        from: ['PENDING'],
        to: 'SKIPPED',
      });
      if (ok) await appendEvent(client, { executionId, eventType: 'node.skipped', nodeId: skippedId });
    }
    for (const readyId of readiness.ready) {
      const claimed = await casNode(client, {
        executionId,
        nodeId: readyId,
        attempt: 1,
        from: ['PENDING'],
        to: 'READY',
      });
      if (!claimed) continue; // another completion already queued it
      await appendEvent(client, { executionId, eventType: 'node.ready', nodeId: readyId });
      await casNode(client, { executionId, nodeId: readyId, attempt: 1, from: ['READY'], to: 'QUEUED' });
      await appendEvent(client, { executionId, eventType: 'node.queued', nodeId: readyId });
      await insertOutbox(client, { eventType: 'node.task', payload: { executionId, nodeId: readyId, attempt: 1 } });
    }

    if (readiness.terminal === 'SUCCEEDED') {
      const done = await casExecution(client, { executionId, from: ['RUNNING'], to: 'SUCCEEDED', completedAt: true });
      if (done) await appendEvent(client, { executionId, eventType: 'execution.succeeded' });
    } else if (readiness.terminal === 'FAILED') {
      const done = await casExecution(client, {
        executionId,
        from: ['RUNNING'],
        to: 'FAILED',
        completedAt: true,
        errorSummary: 'A node failed',
      });
      if (done) await appendEvent(client, { executionId, eventType: 'execution.failed' });
    }
  });
}
