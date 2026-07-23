import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import {
  createQueues,
  createRedisConnection,
  QUEUE_NAMES,
  startOutboxPublisher,
  type NodeTaskPayload,
} from '@xperiment/queue';
import { Worker } from 'bullmq';
import { pino } from 'pino';
import { runNodeTask, type WorkerDeps } from './runTask.js';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
const pool = createPool();
await runMigrations(pool);

const deps: WorkerDeps = {
  pool,
  registry: createDefaultRegistry({ allowPrivateIps: process.env['HTTP_ALLOW_PRIVATE_IPS'] === 'true' }),
  workerId: `worker-${randomUUID().slice(0, 8)}`,
  log: (msg, extra) => logger.info(extra ?? {}, msg),
};

const connection = createRedisConnection();
const queues = createQueues(connection);
const publisher = startOutboxPublisher({ pool, queues, log: deps.log });

const taskWorker = new Worker<NodeTaskPayload>(QUEUE_NAMES.nodeTask, async (job) => runNodeTask(deps, job.data), {
  connection,
  concurrency: 4,
  lockDuration: Number(process.env['WORKER_LOCK_DURATION'] ?? 30000),
  stalledInterval: Number(process.env['WORKER_STALLED_INTERVAL'] ?? 5000),
  maxStalledCount: 1,
});
taskWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'node task job failed'));

const health = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', workerId: deps.workerId }));
});
health.listen(Number(process.env['WORKER_PORT'] ?? 3002), () => logger.info('worker healthz listening'));

async function shutdown(): Promise<void> {
  logger.info('shutting down');
  await taskWorker.close();
  await publisher.stop();
  for (const q of Object.values(queues)) await q.close();
  connection.disconnect();
  health.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
