import { createServer } from 'node:http';
import { assertBootSafe, createPool, runMigrations } from '@xperiment/db';
import {
  createQueues,
  createRedisConnection,
  QUEUE_NAMES,
  startOutboxPublisher,
  type ExecutionRequestedPayload,
  type NodeCompletedPayload,
  type WatchdogPayload,
} from '@xperiment/queue';
import { Worker } from 'bullmq';
import { pino } from 'pino';
import type { OrchestratorDeps } from './deps.js';
import { handleExecutionRequested } from './handlers/executionRequested.js';
import { handleNodeCompleted } from './handlers/nodeCompleted.js';
import { handleWatchdog } from './handlers/watchdog.js';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
assertBootSafe();
const pool = createPool();
await runMigrations(pool);

const deps: OrchestratorDeps = {
  pool,
  log: (msg, extra) => logger.info(extra ?? {}, msg),
};

const connection = createRedisConnection();
const queues = createQueues(connection);
const publisher = startOutboxPublisher({ pool, queues, log: deps.log });

const workers = [
  new Worker<ExecutionRequestedPayload>(
    QUEUE_NAMES.executionRequested,
    async (job) => handleExecutionRequested(deps, job.data),
    { connection, concurrency: 1 },
  ),
  new Worker<NodeCompletedPayload>(
    QUEUE_NAMES.nodeCompleted,
    async (job) => handleNodeCompleted(deps, job.data),
    { connection, concurrency: 1 },
  ),
  new Worker<WatchdogPayload>(QUEUE_NAMES.watchdog, async (job) => handleWatchdog(deps, job.data), {
    connection,
    concurrency: 1,
  }),
];
for (const w of workers) {
  w.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'orchestrator job failed'));
}

const health = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok' }));
});
health.listen(Number(process.env['ORCH_PORT'] ?? 3001), () => logger.info('orchestrator healthz listening'));

async function shutdown(): Promise<void> {
  logger.info('shutting down');
  for (const w of workers) await w.close();
  await publisher.stop();
  for (const q of Object.values(queues)) await q.close();
  connection.disconnect();
  health.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
