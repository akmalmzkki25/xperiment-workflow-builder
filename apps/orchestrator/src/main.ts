import { assertBootSafe, createPool, runMigrations } from '@xperiment/db';
import {
  createMetrics,
  createReadiness,
  postgresDependency,
  redisDependency,
  startAdminServer,
} from '@xperiment/observability';
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

const metrics = createMetrics({
  serviceName: 'orchestrator',
  // Queue depth belongs to exactly one exporter. Five services publishing the same
  // series would make every rate() over it five times the truth.
  gauges: [
    {
      name: 'xperiment_queue_depth',
      help: 'Jobs waiting across all Xperiment queues',
      collect: async () => {
        const counts = await Promise.all(Object.values(queues).map((q) => q.getWaitingCount()));
        return counts.reduce((a, b) => a + b, 0);
      },
    },
  ],
});

const admin = await startAdminServer({
  port: Number(process.env['ORCH_PORT'] ?? 3001),
  serviceName: 'orchestrator',
  // Redis is CRITICAL here: without it the orchestrator does nothing at all.
  readiness: createReadiness([postgresDependency(pool), redisDependency(connection, true)]),
  metrics,
  metricsToken: process.env['METRICS_TOKEN'],
  log: (msg, extra) => logger.info(extra ?? {}, msg),
});

async function shutdown(): Promise<void> {
  logger.info('shutting down');
  for (const w of workers) await w.close();
  await publisher.stop();
  for (const q of Object.values(queues)) await q.close();
  connection.disconnect();
  await admin.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
