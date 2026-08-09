import { createServer } from 'node:http';
import { assertBootSafe, createPool, runMigrations } from '@xperiment/db';
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

const health = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok' }));
});
health.listen(Number(process.env['SCHEDULER_PORT'] ?? 3004), () => logger.info('scheduler healthz listening'));

async function shutdown(): Promise<void> {
  logger.info('shutting down');
  clearInterval(timer);
  await publisher.stop();
  for (const q of Object.values(queues)) await q.close();
  connection.disconnect();
  health.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
