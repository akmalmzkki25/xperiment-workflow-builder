import { appendEvent, casExecution, casNode, insertOutbox, withTx } from '@xperiment/db';
import type { ExecutionRequestedPayload } from '@xperiment/queue';
import { loadExecutionContext, type OrchestratorDeps } from '../deps.js';

export async function handleExecutionRequested(
  deps: OrchestratorDeps,
  payload: ExecutionRequestedPayload,
): Promise<void> {
  const ctx = await loadExecutionContext(deps.pool, payload.executionId);
  if (!ctx) {
    deps.log('execution_requested.unknown_execution', { executionId: payload.executionId });
    return;
  }
  const { executionId } = payload;
  const entrypoint = ctx.ir.entrypoints[0]!;

  await withTx(deps.pool, async (client) => {
    const claimed = await casExecution(client, { executionId, from: ['CREATED'], to: 'QUEUED' });
    if (!claimed) {
      deps.log('execution_requested.duplicate', { executionId });
      return;
    }
    await appendEvent(client, { executionId, eventType: 'execution.queued' });

    await casNode(client, { executionId, nodeId: entrypoint, attempt: 1, from: ['PENDING'], to: 'READY' });
    await appendEvent(client, { executionId, eventType: 'node.ready', nodeId: entrypoint });
    await casNode(client, { executionId, nodeId: entrypoint, attempt: 1, from: ['READY'], to: 'QUEUED' });
    await appendEvent(client, { executionId, eventType: 'node.queued', nodeId: entrypoint });
    await insertOutbox(client, {
      eventType: 'node.task',
      payload: { executionId, nodeId: entrypoint, attempt: 1 },
    });

    await casExecution(client, { executionId, from: ['QUEUED'], to: 'RUNNING', startedAt: true });
    await appendEvent(client, { executionId, eventType: 'execution.running' });
  });
}
