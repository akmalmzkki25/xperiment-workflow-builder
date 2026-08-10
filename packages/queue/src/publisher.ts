import { claimOutbox, deadLetterOutbox, markPublished, MAX_PUBLISH_ATTEMPTS, releaseOutbox } from '@xperiment/db';
import { type JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { QUEUE_NAMES, type QueueKey } from './names.js';
import { jobIdFor } from './payloads.js';

export type Queues = Record<QueueKey, Queue>;

/**
 * Completion-webhook delivery is the ONLY queue with BullMQ-level retries: its
 * consumer (runCallback) throws on a non-2xx/timeout and has no application-level
 * re-enqueue (unlike node.task, which self-retries via RETRY_SCHEDULED). Without
 * these attempts a single transient receiver failure would drop the webhook
 * permanently. Node/execution queues deliberately keep attempts=1 so a throwing
 * processor never re-runs a side-effecting node twice.
 */
export const CALLBACK_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
};

export function createQueues(connection: Redis): Queues {
  const make = (name: string, extra?: JobsOptions) =>
    new Queue(name, {
      connection,
      defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 }, ...extra },
    });
  return {
    executionRequested: make(QUEUE_NAMES.executionRequested),
    nodeTask: make(QUEUE_NAMES.nodeTask),
    nodeCompleted: make(QUEUE_NAMES.nodeCompleted),
    watchdog: make(QUEUE_NAMES.watchdog),
    executionCallback: make(QUEUE_NAMES.executionCallback, CALLBACK_JOB_OPTIONS),
    alertNotify: make(QUEUE_NAMES.alertNotify, CALLBACK_JOB_OPTIONS),
  };
}

const EVENT_TO_QUEUE: Record<string, QueueKey> = {
  'execution.requested': 'executionRequested',
  'node.task': 'nodeTask',
  'node.completed': 'nodeCompleted',
  'execution.watchdog': 'watchdog',
  'execution.callback': 'executionCallback',
  'alert.notify': 'alertNotify',
};

export interface OutboxPublisher {
  stop(): Promise<void>;
}

export function startOutboxPublisher(opts: {
  pool: pg.Pool;
  queues: Queues;
  intervalMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): OutboxPublisher {
  const intervalMs = opts.intervalMs ?? 250;
  const log = opts.log ?? (() => {});
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const rows = await claimOutbox(opts.pool, 50);
      const publishedIds: string[] = [];
      for (const row of rows) {
        const key = EVENT_TO_QUEUE[row.eventType];
        if (!key) {
          // No queue will ever accept this. Leaving it unpublished meant five
          // processes re-read and re-logged it every 250ms forever, and it held a
          // slot in every batch because the claim is ordered by age.
          await deadLetterOutbox(opts.pool, row, `no queue is mapped to event type '${row.eventType}'`);
          log('outbox.dead_lettered', { eventType: row.eventType, id: row.id, reason: 'unknown_event_type' });
          continue;
        }
        try {
          const payload = row.payload as Record<string, unknown>;
          await opts.queues[key].add(row.eventType, payload, {
            jobId: jobIdFor(row.eventType, payload, row.replaySeq),
            ...(row.delayMs > 0 ? { delay: row.delayMs } : {}),
          });
          publishedIds.push(row.id);
        } catch (e) {
          // Per row, not per batch. A throw here used to unwind past markPublished,
          // so every row already on the queue kept published_at NULL and was
          // published again on the next tick.
          const message = (e as Error).message;
          if (row.attempts >= MAX_PUBLISH_ATTEMPTS) {
            await deadLetterOutbox(opts.pool, row, message);
            log('outbox.dead_lettered', { eventType: row.eventType, id: row.id, attempts: row.attempts });
          } else {
            await releaseOutbox(opts.pool, row.id, message);
            log('outbox.publish_failed', { id: row.id, attempts: row.attempts, error: message });
          }
        }
      }
      await markPublished(opts.pool, publishedIds);
      if (publishedIds.length > 0) log('outbox.published', { count: publishedIds.length });
    } catch (e) {
      log('outbox.publish_error', { error: (e as Error).message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 10));
    },
  };
}
