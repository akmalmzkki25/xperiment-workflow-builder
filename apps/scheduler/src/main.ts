import { assertBootSafe, createPool, outboxHealth, pruneExpired, runMigrations } from '@xperiment/db';
import {
  createMetrics,
  createReadiness,
  postgresDependency,
  redisDependency,
  startAdminServer,
} from '@xperiment/observability';
import { createQueues, createRedisConnection, startOutboxPublisher } from '@xperiment/queue';
import { pino } from 'pino';
import { runAlertSweep } from './alertSweep.js';
import { runInvoiceSweep } from './invoiceSweep.js';
import { runSchedulerTick } from './tick.js';
import { runWaitSweep } from './waitSweep.js';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
assertBootSafe();
const pool = createPool();
await runMigrations(pool);

const connection = createRedisConnection();
const queues = createQueues(connection);
const publisher = startOutboxPublisher({ pool, queues, log: (msg, extra) => logger.info(extra ?? {}, msg) });

const intervalMs = Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 5000);
let running = false;
const log = (msg: string, extra?: Record<string, unknown>) => logger.info(extra ?? {}, msg);

/**
 * Retention runs on its own, much slower clock.
 *
 * Not on the 5s tick: a sweep takes locks on the largest tables in the system, and
 * doing that twelve times a minute would fight the workload it is meant to serve.
 */
const pruneIntervalMs = Number(process.env['PRUNE_INTERVAL_MS'] ?? 3_600_000);
let pruning = false;
const pruneTimer = setInterval(() => {
  if (pruning) return;
  pruning = true;
  void pruneExpired(pool)
    .then((result) => {
      const total = Object.values(result).reduce((a, b) => a + b, 0);
      if (total > 0) log('retention.pruned', { ...result });
    })
    .catch((e: unknown) => logger.error({ err: (e as Error).message }, 'retention sweep failed'))
    .finally(() => {
      pruning = false;
    });
}, pruneIntervalMs);
const timer = setInterval(() => {
  if (running) return;
  running = true;
  void Promise.all([
    runSchedulerTick({ pool, log }),
    runWaitSweep({ pool, log }),
    runAlertSweep({ pool, log }),
    runInvoiceSweep({ pool, log }),
  ])
    .catch((e: unknown) => logger.error({ err: (e as Error).message }, 'scheduler tick failed'))
    .finally(() => {
      running = false;
    });
}, intervalMs);

const metrics = createMetrics({
  serviceName: 'scheduler',
  // Outbox health is exported from here ONLY. All five services run a publisher, so
  // five exporters of the same series would multiply every reading by five.
  gauges: [
    { name: 'xperiment_outbox_pending', help: 'Outbox rows not yet published', collect: async () => (await outboxHealth(pool)).pending },
    {
      name: 'xperiment_outbox_struggling',
      help: 'Outbox rows past the publish attempt cap',
      collect: async () => (await outboxHealth(pool)).struggling,
    },
    {
      name: 'xperiment_outbox_dead',
      help: 'Dead-lettered outbox rows awaiting a replay',
      collect: async () => (await outboxHealth(pool)).dead,
    },
  ],
});

const admin = await startAdminServer({
  port: Number(process.env['SCHEDULER_PORT'] ?? 3004),
  serviceName: 'scheduler',
  readiness: createReadiness([postgresDependency(pool), redisDependency(connection, true)]),
  metrics,
  metricsToken: process.env['METRICS_TOKEN'],
  log: (msg, extra) => logger.info(extra ?? {}, msg),
});

async function shutdown(): Promise<void> {
  logger.info('shutting down');
  clearInterval(timer);
  clearInterval(pruneTimer);
  await publisher.stop();
  for (const q of Object.values(queues)) await q.close();
  connection.disconnect();
  await admin.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
