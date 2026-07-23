import { createPool, insertOutbox, runMigrations } from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createQueues,
  createRedisConnection,
  jobIdFor,
  startOutboxPublisher,
} from '../src/index.js';

let pool: Pool;
let connection: ReturnType<typeof createRedisConnection>;
let queues: ReturnType<typeof createQueues>;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  connection = createRedisConnection();
  queues = createQueues(connection);
});
afterAll(async () => {
  for (const q of Object.values(queues)) await q.close();
  connection.disconnect();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE task_outbox`);
  for (const q of Object.values(queues)) await q.obliterate({ force: true });
});

describe('jobIdFor', () => {
  test('formats ids per event type', () => {
    expect(jobIdFor('execution.requested', { executionId: 'E' })).toBe('exec-req_E');
    expect(jobIdFor('node.task', { executionId: 'E', nodeId: 'n', attempt: 2 })).toBe('node-task_E_n_2');
    expect(jobIdFor('node.completed', { executionId: 'E', nodeId: 'n', attempt: 1 })).toBe('node-done_E_n_1');
    expect(jobIdFor('execution.watchdog', { executionId: 'E' })).toBe('watchdog_E');
    expect(() => jobIdFor('bogus.event', {})).toThrow();
  });
});

describe('startOutboxPublisher', () => {
  test('publishes pending rows to the right queues and marks them', async () => {
    await insertOutbox(pool, { eventType: 'execution.requested', payload: { executionId: 'E1' } });
    await insertOutbox(pool, {
      eventType: 'node.task',
      payload: { executionId: 'E1', nodeId: 'a', attempt: 1 },
    });
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const reqJob = await queues.executionRequested.getJob('exec-req_E1');
      expect(reqJob?.data).toEqual({ executionId: 'E1' });
      const taskJob = await queues.nodeTask.getJob('node-task_E1_a_1');
      expect(taskJob?.data).toEqual({ executionId: 'E1', nodeId: 'a', attempt: 1 });
      const remaining = await pool.query(`SELECT count(*)::int AS c FROM task_outbox WHERE published_at IS NULL`);
      expect((remaining.rows[0] as { c: number }).c).toBe(0);
    } finally {
      await publisher.stop();
    }
  });

  test('delayMs becomes a delayed job', async () => {
    await insertOutbox(pool, { eventType: 'execution.watchdog', payload: { executionId: 'E2' }, delayMs: 60000 });
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const job = await queues.watchdog.getJob('watchdog_E2');
      expect(job).toBeDefined();
      expect(await job!.getState()).toBe('delayed');
    } finally {
      await publisher.stop();
    }
  });

  test('republish with same jobId does not duplicate an existing waiting job', async () => {
    await insertOutbox(pool, { eventType: 'execution.requested', payload: { executionId: 'E3' } });
    await insertOutbox(pool, { eventType: 'execution.requested', payload: { executionId: 'E3' } });
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const waiting = await queues.executionRequested.getJobs(['waiting', 'delayed']);
      expect(waiting.filter((j) => j.id === 'exec-req_E3')).toHaveLength(1);
    } finally {
      await publisher.stop();
    }
  });
});
