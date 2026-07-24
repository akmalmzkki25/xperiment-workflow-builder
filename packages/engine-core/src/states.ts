export const EXECUTION_STATUSES = [
  'CREATED',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELED',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const NODE_STATUSES = [
  'PENDING',
  'READY',
  'QUEUED',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'RETRY_SCHEDULED',
  'FAILED',
  'SKIPPED',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
