import { describe, expect, test } from 'vitest';
import {
  canTransitionExecution,
  canTransitionNode,
  EXECUTION_STATUSES,
  NODE_STATUSES,
  type ExecutionStatus,
  type NodeStatus,
} from '../src/index.js';

const ALLOWED_EXECUTION: [ExecutionStatus, ExecutionStatus][] = [
  ['CREATED', 'QUEUED'],
  ['QUEUED', 'RUNNING'],
  ['QUEUED', 'TIMED_OUT'],
  ['RUNNING', 'SUCCEEDED'],
  ['RUNNING', 'FAILED'],
  ['RUNNING', 'TIMED_OUT'],
];

const ALLOWED_NODE: [NodeStatus, NodeStatus][] = [
  ['PENDING', 'READY'],
  ['PENDING', 'SKIPPED'],
  ['PENDING', 'FAILED'], // watchdog
  ['READY', 'QUEUED'],
  ['READY', 'FAILED'], // watchdog
  ['QUEUED', 'RUNNING'],
  ['QUEUED', 'FAILED'], // watchdog
  ['RUNNING', 'SUCCEEDED'],
  ['RUNNING', 'WAITING'],
  ['RUNNING', 'RETRY_SCHEDULED'],
  ['RUNNING', 'FAILED'],
  ['WAITING', 'SUCCEEDED'], // resume (approval/event/timer)
  ['WAITING', 'FAILED'], // expiry with fail fallback
  ['WAITING', 'SKIPPED'], // execution failing elsewhere
];

describe('execution transition matrix', () => {
  test('allows exactly the documented transitions', () => {
    for (const from of EXECUTION_STATUSES) {
      for (const to of EXECUTION_STATUSES) {
        const allowed = ALLOWED_EXECUTION.some(([f, t]) => f === from && t === to);
        expect(canTransitionExecution(from, to), `${from} -> ${to}`).toBe(allowed);
      }
    }
  });
});

describe('node transition matrix', () => {
  test('allows exactly the documented transitions', () => {
    for (const from of NODE_STATUSES) {
      for (const to of NODE_STATUSES) {
        const allowed = ALLOWED_NODE.some(([f, t]) => f === from && t === to);
        expect(canTransitionNode(from, to), `${from} -> ${to}`).toBe(allowed);
      }
    }
  });

  test('terminal statuses allow nothing', () => {
    for (const from of ['SUCCEEDED', 'FAILED', 'SKIPPED', 'RETRY_SCHEDULED'] as NodeStatus[]) {
      for (const to of NODE_STATUSES) {
        expect(canTransitionNode(from, to)).toBe(false);
      }
    }
  });
});
