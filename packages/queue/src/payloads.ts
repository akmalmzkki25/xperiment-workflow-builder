export interface ExecutionRequestedPayload {
  executionId: string;
}

export interface NodeTaskPayload {
  executionId: string;
  nodeId: string;
  attempt: number;
}

export interface NodeCompletedPayload {
  executionId: string;
  nodeId: string;
  attempt: number;
  status: 'SUCCEEDED' | 'FAILED' | 'RETRY_SCHEDULED';
  outputPort?: string;
  /** Worker-computed backoff for the NEXT attempt (RETRY_SCHEDULED only). */
  delayMs?: number;
}

export interface WatchdogPayload {
  executionId: string;
}

/**
 * The BullMQ job id for an outbox row.
 *
 * NOTE: BullMQ forbids ':' in custom job ids (it is the Redis key delimiter), so
 * segments are joined with '_'.
 *
 * `replaySeq` is what makes a replayed dead letter a DIFFERENT job. BullMQ dedupes on
 * this id and does it silently — a second add returns the existing job and never
 * throws — so a replay that reproduced the original id was swallowed for as long as
 * the completed job survived in Redis, and ran only if the operator had waited past
 * that. Zero for originals, so every existing id is unchanged.
 */
export function jobIdFor(eventType: string, payload: Record<string, unknown>, replaySeq = 0): string {
  const suffix = replaySeq > 0 ? `_r${replaySeq}` : '';
  return `${baseJobId(eventType, payload)}${suffix}`;
}

function baseJobId(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case 'execution.requested':
      return `exec-req_${payload['executionId']}`;
    case 'node.task':
      return `node-task_${payload['executionId']}_${payload['nodeId']}_${payload['attempt']}`;
    case 'node.completed':
      return `node-done_${payload['executionId']}_${payload['nodeId']}_${payload['attempt']}`;
    case 'execution.watchdog':
      return `watchdog_${payload['executionId']}`;
    case 'execution.callback':
      return `callback_${payload['executionId']}`;
    case 'alert.notify':
      return `alert_${payload['eventId']}`;
    default:
      throw new Error(`Unknown outbox event type '${eventType}'`);
  }
}
