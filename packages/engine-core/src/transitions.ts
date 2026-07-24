import type { ExecutionStatus, NodeStatus } from './states.js';

export const EXECUTION_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  CREATED: ['QUEUED'],
  QUEUED: ['RUNNING', 'TIMED_OUT'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'TIMED_OUT'],
  SUCCEEDED: [],
  FAILED: [],
  TIMED_OUT: [],
};

// RETRY_SCHEDULED is row-terminal: the logical retry continues as a NEW
// execution_nodes row for attempt N+1 (created QUEUED), so no row ever
// transitions out of RETRY_SCHEDULED.
export const NODE_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  PENDING: ['READY', 'SKIPPED', 'FAILED'],
  READY: ['QUEUED', 'FAILED'],
  QUEUED: ['RUNNING', 'FAILED'],
  RUNNING: ['SUCCEEDED', 'WAITING', 'RETRY_SCHEDULED', 'FAILED'],
  // WAITING is durable-suspended: a resume (approval, event callback, or timer
  // sweep) transitions it in place to a terminal.
  WAITING: ['SUCCEEDED', 'FAILED', 'SKIPPED'],
  SUCCEEDED: [],
  RETRY_SCHEDULED: [],
  FAILED: [],
  SKIPPED: [],
};

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}
