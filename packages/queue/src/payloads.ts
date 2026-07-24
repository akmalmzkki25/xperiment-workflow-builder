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

// NOTE: BullMQ forbids ':' in custom job ids (it is the Redis key delimiter),
// so segments are joined with '_'.
export function jobIdFor(eventType: string, payload: Record<string, unknown>): string {
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
