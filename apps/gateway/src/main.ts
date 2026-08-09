import { assertBootSafe,
  createKeyProviderFromEnv,
  createPool,
  createSecretVault,
  createWorkspaceKeyring,
  deriveLegacyKey,
  runMigrations,
} from '@xperiment/db';
import { createQueues, createRedisConnection, startOutboxPublisher } from '@xperiment/queue';
import { buildGateway } from './server.js';

assertBootSafe();
const pool = createPool();
await runMigrations(pool);

const keyring = createWorkspaceKeyring({
  pool,
  provider: await createKeyProviderFromEnv(),
  ...(process.env['KEK_CACHE_TTL_MS'] ? { ttlMs: Number(process.env['KEK_CACHE_TTL_MS']) } : {}),
});
const app = buildGateway({
  pool,
  triggerVault: createSecretVault({
    keyring,
    legacyKey: deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
  }),
});

const redis = createRedisConnection();
const queues = createQueues(redis);
const publisher = startOutboxPublisher({
  pool,
  queues,
  log: (msg, extra) => app.log.info(extra ?? {}, msg),
});

const port = Number(process.env['GATEWAY_PORT'] ?? 3003);
await app.listen({ port, host: '0.0.0.0' });
app.log.info({ port }, 'gateway listening');

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
