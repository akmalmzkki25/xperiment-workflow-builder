import { Redis } from 'ioredis';

// 6379 falls inside a Windows excluded port range on the reference dev
export const DEFAULT_REDIS_URL = 'redis://:dev_password_change_me@localhost:6379/0';

/**
 * The BullMQ connection.
 *
 * `maxRetriesPerRequest: null` is BullMQ's hard requirement for its blocking commands.
 * It also means a command issued while Redis is unreachable QUEUES FOREVER rather than
 * rejecting — fine for a background worker, catastrophic on a request path. Anything
 * that runs inside an HTTP handler must use `createLimiterRedis` instead.
 */
export function createRedisConnection(url?: string): Redis {
  return new Redis(url ?? process.env['REDIS_URL'] ?? DEFAULT_REDIS_URL, {
    maxRetriesPerRequest: null,
  });
}

/** A command on the login path that has not answered by now has already failed. */
export const LIMITER_COMMAND_TIMEOUT_MS = 250;

/**
 * A connection safe to use inside a request.
 *
 * Everything here exists to make failure FAST. `enableOfflineQueue: false` rejects
 * immediately instead of buffering while disconnected; `commandTimeout` bounds a
 * command that was accepted and then stranded; `maxRetriesPerRequest: 1` stops
 * ioredis from retrying a doomed command behind the caller's back. Without these a
 * Redis outage would hang every login rather than degrade the limiter.
 *
 * The 'error' listener is not optional: an ioredis client with no listener turns a
 * connection error into an uncaught exception.
 */
export function createLimiterRedis(url?: string, onError?: (error: Error) => void): Redis {
  const client = new Redis(url ?? process.env['REDIS_URL'] ?? DEFAULT_REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: LIMITER_COMMAND_TIMEOUT_MS,
    connectTimeout: 1000,
    // Do not hammer a Redis that is down; the store falls back to memory anyway.
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  client.on('error', (e: Error) => onError?.(e));
  return client;
}
