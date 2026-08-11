import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createLimiterRedis,
  LIMITER_PREFIX,
  limiterKey,
  MemoryLimiterStore,
  RedisLimiterStore,
} from '../src/index.js';

const WINDOW = 60_000;

describe('MemoryLimiterStore', () => {
  test('counts within the window and restarts after it', async () => {
    let clock = 0;
    const store = new MemoryLimiterStore(() => clock);
    expect(await store.hit('k', WINDOW)).toBe(1);
    expect(await store.hit('k', WINDOW)).toBe(2);
    clock = WINDOW;
    expect(await store.hit('k', WINDOW)).toBe(1);
  });

  test('keys do not share a counter', async () => {
    const store = new MemoryLimiterStore();
    await store.hit('a', WINDOW);
    expect(await store.hit('b', WINDOW)).toBe(1);
  });

  test('reset returns the whole budget', async () => {
    const store = new MemoryLimiterStore();
    await store.hit('k', WINDOW);
    await store.hit('k', WINDOW);
    await store.reset('k');
    expect(await store.hit('k', WINDOW)).toBe(1);
  });

  test('sweep evicts expired windows, which nothing else does', async () => {
    // The map grew forever: an expired window was only ever overwritten by a repeat
    // hit on the same key, never removed.
    let clock = 0;
    const store = new MemoryLimiterStore(() => clock);
    for (let i = 0; i < 100; i += 1) await store.hit(`k${i}`, WINDOW);
    expect(store.size).toBe(100);
    clock = WINDOW;
    store.sweep(WINDOW);
    expect(store.size).toBe(0);
  });
});

describe('limiterKey', () => {
  test('is opaque: the raw email never reaches Redis', async () => {
    // `SCAN xperiment:rl:*` over raw keys would list every account that ever tried to log
    // in — a customer email list handed over by a rate limiter.
    const key = limiterKey('budi@example.com:203.0.113.4');
    expect(key.startsWith(LIMITER_PREFIX)).toBe(true);
    expect(key).not.toContain('budi');
    expect(key).not.toContain('example.com');
    expect(key).not.toContain('203.0.113.4');
  });

  test('is stable and collision-distinct', () => {
    expect(limiterKey('a')).toBe(limiterKey('a'));
    expect(limiterKey('a')).not.toBe(limiterKey('b'));
  });

  test('is keyed, so it is not an oracle for whether an address is a customer', () => {
    // A bare sha256 stops enumeration but not confirmation: guess one address, compute
    // the same digest, ask EXISTS. Different secrets must give different keys.
    expect(limiterKey('budi@example.com', 'secret-a')).not.toBe(limiterKey('budi@example.com', 'secret-b'));
  });
});

describe('RedisLimiterStore', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = createLimiterRedis();
    // enableOfflineQueue: false rejects commands issued before the handshake finishes.
    // That is the intended trade — fail fast rather than buffer — and in production it
    // means the limiter degrades to memory for the first moments after boot.
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve) => {
        redis.once('ready', () => resolve());
      });
    }
  });
  afterAll(async () => {
    // Scoped delete, NEVER a flush: this Redis database is shared with other
    // applications on a developer box, and a live 60-second counter left behind would
    // bleed into the next run the moment a Redis-backed test is appended below.
    const keys = await redis.keys(`${LIMITER_PREFIX}*`).catch(() => [] as string[]);
    if (keys.length > 0) await redis.del(...keys).catch(() => undefined);
    await redis.quit().catch(() => undefined);
  });
  beforeEach(async () => {
    const keys = await redis.keys(`${LIMITER_PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  test('counts across separate store instances, which is the whole point', async () => {
    // Two stores stand in for two API replicas. In-process state gave each its own
    // budget, so a cap of five became five per replica.
    const a = new RedisLimiterStore(redis);
    const b = new RedisLimiterStore(redis);
    expect(await a.hit('shared', WINDOW)).toBe(1);
    expect(await b.hit('shared', WINDOW)).toBe(2);
    expect(await a.hit('shared', WINDOW)).toBe(3);
  });

  test('the expiry is set once and never extended', async () => {
    // Re-setting it on every hit turns the fixed window into a sliding one, so a
    // caller who keeps trying is never let back in.
    const store = new RedisLimiterStore(redis);
    await store.hit('ttl', WINDOW);
    const first = await redis.pttl(limiterKey('ttl'));
    await new Promise((r) => setTimeout(r, 60));
    await store.hit('ttl', WINDOW);
    const second = await redis.pttl(limiterKey('ttl'));
    expect(second).toBeLessThan(first);
  });

  test('the window really expires', async () => {
    const store = new RedisLimiterStore(redis);
    expect(await store.hit('short', 120)).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await store.hit('short', 120)).toBe(1);
  });

  test('twenty concurrent hits produce twenty distinct counts', async () => {
    const store = new RedisLimiterStore(redis);
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.hit('race', WINDOW)));
    expect(new Set(counts).size).toBe(20);
    expect(Math.max(...counts)).toBe(20);
  });

  test('reset clears the shared counter', async () => {
    const store = new RedisLimiterStore(redis);
    await store.hit('r', WINDOW);
    await store.hit('r', WINDOW);
    await store.reset('r');
    expect(await store.hit('r', WINDOW)).toBe(1);
  });

  test('a Redis failure degrades to per-replica counting, not to no limit', async () => {
    // Failing closed would take the login path down; failing open would remove the
    // limit entirely. Falling back keeps a weaker bound, which beats both.
    const onFallback = vi.fn();
    const broken = {
      eval: async () => {
        throw new Error('ECONNREFUSED');
      },
      del: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const store = new RedisLimiterStore(broken, { onFallback });
    expect(await store.hit('down', WINDOW)).toBe(1);
    expect(await store.hit('down', WINDOW)).toBe(2);
    expect(onFallback).toHaveBeenCalled();
    // And a reset still works against the fallback rather than throwing.
    await store.reset('down');
    expect(await store.hit('down', WINDOW)).toBe(1);
  });
});
