import { fetchUnpublished, markPublished } from '@xperiment/db';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { QUEUE_NAMES, type QueueKey } from './names.js';
import { jobIdFor } from './payloads.js';

export type Queues = Record<QueueKey, Queue>;

export function createQueues(connection: Redis): Queues {
  const make = (name: string) =>
    new Queue(name, {
      connection,
      defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 } },
    });
  return {
    executionRequested: make(QUEUE_NAMES.executionRequested),
    nodeTask: make(QUEUE_NAMES.nodeTask),
    nodeCompleted: make(QUEUE_NAMES.nodeCompleted),
    watchdog: make(QUEUE_NAMES.watchdog),
    executionCallback: make(QUEUE_NAMES.executionCallback),
  };
}

const EVENT_TO_QUEUE: Record<string, QueueKey> = {
  'execution.requested': 'executionRequested',
  'node.task': 'nodeTask',
  'node.completed': 'nodeCompleted',
  'execution.watchdog': 'watchdog',
  'execution.callback': 'executionCallback',
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
      const rows = await fetchUnpublished(opts.pool, 50);
      const publishedIds: string[] = [];
      for (const row of rows) {
        const key = EVENT_TO_QUEUE[row.eventType];
        if (!key) {
          log('outbox.unknown_event_type', { eventType: row.eventType, id: row.id });
          continue;
        }
        const payload = row.payload as Record<string, unknown>;
        await opts.queues[key].add(row.eventType, payload, {
          jobId: jobIdFor(row.eventType, payload),
          ...(row.delayMs > 0 ? { delay: row.delayMs } : {}),
        });
        publishedIds.push(row.id);
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
