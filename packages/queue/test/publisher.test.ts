import { createPool, insertOutbox, listDeadLetters, runMigrations } from '@xperiment/db';
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
  await pool.query(`DELETE FROM outbox_dead_letters`);
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

  test('a replayed row gets a different id, because BullMQ dedupes silently', () => {
    // A second add with an existing id returns the existing job and never throws, so a
    // replay reusing the original id simply does not run — for as long as the completed
    // job survives in Redis, and then suddenly does. Zero leaves originals untouched.
    expect(jobIdFor('node.task', { executionId: 'E', nodeId: 'n', attempt: 2 }, 0)).toBe('node-task_E_n_2');
    expect(jobIdFor('node.task', { executionId: 'E', nodeId: 'n', attempt: 2 }, 1)).toBe('node-task_E_n_2_r1');
    expect(jobIdFor('node.task', { executionId: 'E', nodeId: 'n', attempt: 2 }, 2)).toBe('node-task_E_n_2_r2');
    // Still no ':' — BullMQ rejects it as the Redis key delimiter.
    expect(jobIdFor('alert.notify', { eventId: 'EV' }, 3)).not.toContain(':');
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

  test('an event type with no queue is dead-lettered rather than retried forever', async () => {
    // It used to be logged and left in place, so five processes re-read and re-logged
    // it every 250ms and it held a slot in every batch, for as long as the table lived.
    await pool.query(
      `INSERT INTO task_outbox (event_type, payload_json, delay_ms) VALUES ('bogus.event', '{}'::jsonb, 0)`,
    );
    const logged: string[] = [];
    const publisher = startOutboxPublisher({ pool, queues, intervalMs: 50, log: (msg) => logged.push(msg) });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(logged).toContain('outbox.dead_lettered');
      const remaining = await pool.query(`SELECT count(*)::int AS c FROM task_outbox WHERE published_at IS NULL`);
      expect((remaining.rows[0] as { c: number }).c).toBe(0);
      const dead = await listDeadLetters(pool);
      expect(dead.map((d) => d.eventType)).toContain('bogus.event');
    } finally {
      await publisher.stop();
    }
  });

  test('one failing row does not strand the rows published beside it', async () => {
    // markPublished sat after the loop, so a throw unwound past it and every row
    // already on the queue kept published_at NULL and was published again next tick.
    await insertOutbox(pool, { eventType: 'execution.requested', payload: { executionId: 'E-bad' } });
    await insertOutbox(pool, { eventType: 'node.task', payload: { executionId: 'E-ok', nodeId: 'n', attempt: 1 } });
    const partlyThrowing = {
      ...queues,
      executionRequested: {
        add: async () => {
          throw new Error('redis down');
        },
      },
    } as unknown as typeof queues;
    const publisher = startOutboxPublisher({ pool, queues: partlyThrowing, intervalMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(await queues.nodeTask.getJob('node-task_E-ok_n_1')).toBeDefined();
      const stranded = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM task_outbox WHERE published_at IS NULL AND event_type = 'node.task'`,
      );
      expect(stranded.rows[0]!.c).toBe(0);
    } finally {
      await publisher.stop();
    }
  });

  test('a persistently failing row is retried, then given up on rather than retried forever', async () => {
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
      // One tick: the row is released for another go, with the reason recorded.
      await new Promise((r) => setTimeout(r, 120));
      const mid = await pool.query<{ c: number; last_error: string | null }>(
        `SELECT count(*)::int AS c, max(last_error) AS last_error FROM task_outbox WHERE published_at IS NULL`,
      );
      expect(mid.rows[0]!.c).toBe(1);
      expect(mid.rows[0]!.last_error).toContain('redis down');
      expect(logged).toContain('outbox.publish_failed');

      // Left alone it used to retry forever. Past the attempt cap it now stops.
      await new Promise((r) => setTimeout(r, 600));
      const after = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM task_outbox WHERE published_at IS NULL`,
      );
      expect(after.rows[0]!.c).toBe(0);
      const dead = await listDeadLetters(pool);
      expect(dead).toHaveLength(1);
      expect(dead[0]!.lastError).toContain('redis down');
      expect(dead[0]!.attempts).toBeGreaterThanOrEqual(5);
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
