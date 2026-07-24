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
  // Drain leftover jobs so they don't linger in the shared Redis DB and get
  // picked up (and harmlessly rejected) by the e2e worker on a later run.
  for (const q of Object.values(queues)) await q.obliterate({ force: true });
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
    expect(jobIdFor('alert.notify', { eventId: 'EV' })).toBe('alert_EV');
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

  test('unknown event type is logged and left unpublished', async () => {
    await pool.query(
      `INSERT INTO task_outbox (event_type, payload_json, delay_ms) VALUES ('bogus.event', '{}'::jsonb, 0)`,
    );
    const logged: string[] = [];
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50, log: (msg) => logged.push(msg) });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(logged).toContain('outbox.unknown_event_type');
      const remaining = await pool.query(`SELECT count(*)::int AS c FROM task_outbox WHERE published_at IS NULL`);
      expect((remaining.rows[0] as { c: number }).c).toBe(1); // bogus row never marked
    } finally {
      await publisher.stop();
    }
  });

  test('publish errors are caught, logged, and the loop keeps running', async () => {
    await insertOutbox(pool, { eventType: 'execution.requested', payload: { executionId: 'E-err' } });
    const throwingQueues = {
      ...queues,
      executionRequested: {
        add: async () => {
          throw new Error('redis down');
        },
      },
    } as unknown as typeof queues;
    const logged: string[] = [];
    const publisher = startOutboxPublisher({
      pool,
      queues: throwingQueues,
      intervalMs: 50,
      log: (msg) => logged.push(msg),
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(logged).toContain('outbox.publish_error');
      const remaining = await pool.query(`SELECT count(*)::int AS c FROM task_outbox WHERE published_at IS NULL`);
      expect((remaining.rows[0] as { c: number }).c).toBe(1); // row stays for a later retry
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

  test('completion-callback jobs carry BullMQ retries so a transient failure is not dropped', async () => {
    await insertOutbox(pool, { eventType: 'execution.callback', payload: { executionId: 'ECB' } });
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const job = await queues.executionCallback.getJob('callback_ECB');
      expect(job).toBeDefined();
      expect(job!.opts.attempts).toBe(5);
      expect(job!.opts.backoff).toMatchObject({ type: 'exponential' });
    } finally {
      await publisher.stop();
    }
  });

  test('alert.notify jobs carry BullMQ retries', async () => {
    await insertOutbox(pool, { eventType: 'alert.notify', payload: { ruleId: 'R', eventId: 'EV' } });
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const job = await queues.alertNotify.getJob('alert_EV');
      expect(job).toBeDefined();
      expect(job!.opts.attempts).toBe(5);
    } finally {
      await publisher.stop();
    }
  });

  test('node-task jobs keep attempts=1 so a throwing processor never double-runs a node', async () => {
    await insertOutbox(pool, { eventType: 'node.task', payload: { executionId: 'ENT', nodeId: 'a', attempt: 1 } });
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const job = await queues.nodeTask.getJob('node-task_ENT_a_1');
      expect(job).toBeDefined();
      // Unconfigured → BullMQ stores attempts 0 (effective single run). The point
      // is simply that node tasks never get multi-attempt BullMQ retries.
      expect((job!.opts.attempts ?? 0) < 2).toBe(true);
    } finally {
      await publisher.stop();
    }
  });
});
