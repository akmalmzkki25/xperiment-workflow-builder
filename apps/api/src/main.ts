import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import { createQueues, createRedisConnection, startOutboxPublisher } from '@xperiment/queue';
import { buildServer } from './server.js';

const pool = createPool();
await runMigrations(pool);

const registry = createDefaultRegistry({ allowPrivateIps: process.env['HTTP_ALLOW_PRIVATE_IPS'] === 'true' });
const app = buildServer({ pool, registry });

const redis = createRedisConnection();
const queues = createQueues(redis);
const publisher = startOutboxPublisher({
  pool,
  queues,
  log: (msg, extra) => app.log.info(extra ?? {}, msg),
});

const port = Number(process.env['API_PORT'] ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
app.log.info({ port }, 'api listening');

async function shutdown(): Promise<void> {
  app.log.info('shutting down');
  await publisher.stop();
  await app.close();
  for (const q of Object.values(queues)) await q.close();
  redis.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
