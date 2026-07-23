export const QUEUE_NAMES = {
  executionRequested: 'execution.requested',
  nodeTask: 'node.task',
  nodeCompleted: 'node.completed',
  watchdog: 'execution.watchdog',
} as const;

export type QueueKey = keyof typeof QUEUE_NAMES;
