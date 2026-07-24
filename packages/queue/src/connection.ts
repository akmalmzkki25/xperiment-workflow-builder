import { Redis } from 'ioredis';

// 6379 falls inside a Windows excluded port range on the reference dev
export const DEFAULT_REDIS_URL = 'redis://:dev_password_change_me@localhost:6379/0';

export function createRedisConnection(url?: string): Redis {
  return new Redis(url ?? process.env['REDIS_URL'] ?? DEFAULT_REDIS_URL, {
    maxRetriesPerRequest: null,
  });
}
