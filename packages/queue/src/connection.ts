import { Redis } from 'ioredis';

// 6379 falls inside a Windows excluded port range on the reference dev
// machine; docker-compose maps Redis to 16379 (see docker-compose.yml).
export const DEFAULT_REDIS_URL = 'redis://localhost:16379';

export function createRedisConnection(url?: string): Redis {
  return new Redis(url ?? process.env['REDIS_URL'] ?? DEFAULT_REDIS_URL, {
    maxRetriesPerRequest: null,
  });
}
