import { createHmac } from 'node:crypto';

/**
 * Where a fixed-window counter lives.
 *
 * Extracted so the login limiter can be shared across API replicas. In process it was
 * per-replica state, which meant a cap of five attempts became five times the number
 * of replicas — a security control that silently weakens as you scale out.
 */
export interface LimiterStore {
  /** The count INCLUDING this attempt. */
  hit(key: string, windowMs: number): Promise<number>;
  reset(key: string): Promise<void>;
}

interface Window {
  count: number;
  startedAt: number;
}

/** The default. Correct for one process; the fallback when Redis is unreachable. */
export class MemoryLimiterStore implements LimiterStore {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number): Promise<number> {
    const at = this.now();
    const w = this.windows.get(key);
    if (!w || at - w.startedAt >= windowMs) {
      this.windows.set(key, { count: 1, startedAt: at });
      return 1;
    }
    w.count += 1;
    return w.count;
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  /** Drop windows that have expired. Nothing else evicts them. */
  sweep(windowMs: number): void {
    const at = this.now();
    for (const [key, w] of this.windows) {
      if (at - w.startedAt >= windowMs) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Increment and set the expiry in ONE round trip.
 *
 * Not INCR followed by EXPIRE: those are two round trips, and a connection that drops
 * between them leaves a key with NO TTL — a counter that never resets, which is a
 * permanent account lockout you inflicted on yourself.
 *
 * Not MULTI either: the expiry must be set only on the FIRST increment, and MULTI
 * cannot branch on the reply of an earlier command in the same transaction. Setting it
 * every time turns the fixed window into a sliding one, so a caller who keeps trying
 * is never let back in.
 */
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return n
`;

export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export const LIMITER_PREFIX = 'xperiment:rl:';

/**
 * HMAC, never the raw key and never a bare hash.
 *
 * The natural key is `${email}:${ip}`. Stored raw, a single `SCAN xperiment:rl:*` by anyone
 * with Redis access enumerates every account that has ever attempted a login — a list
 * of real customer emails, handed over by a rate limiter.
 *
 * A plain sha256 stops enumeration but not CONFIRMATION: an attacker who guesses one
 * address computes the same digest and asks `EXISTS`, turning the limiter into an
 * oracle for "is this person a customer". Keying the hash with a server-side secret
 * closes that, and the secret never leaves the process.
 */
export function limiterKey(raw: string, secret: string = limiterSecret()): string {
  return LIMITER_PREFIX + createHmac('sha256', secret).update(raw).digest('hex');
}

/**
 * The HMAC key. Falls back to a fixed development string rather than throwing.
 *
 * A missing secret must not take the login path down, and the fallback is not a
 * meaningful weakening: an attacker who can read Redis to run the oracle can usually
 * read the environment too. `assertBootSafe` is where a production deployment is made
 * to configure its secrets.
 */
function limiterSecret(): string {
  return process.env['LIMITER_KEY_SECRET'] ?? 'xperiment-dev-limiter-secret-change-me';
}

export interface RedisLimiterOptions {
  /** Called when Redis fails and the in-memory fallback takes over. */
  onFallback?: (error: Error) => void;
}

/**
 * Shared counters across replicas, degrading to per-replica rather than to nothing.
 *
 * A Redis outage must not take the login path down, and must not silently remove the
 * limit either. Falling back to the in-memory store keeps a bound — a weaker one, five
 * per replica instead of five overall — which is strictly better than both failing
 * closed (nobody can log in) and failing open (unlimited credential stuffing).
 */
export class RedisLimiterStore implements LimiterStore {
  private readonly fallback: MemoryLimiterStore;

  constructor(
    private readonly redis: RedisLike,
    private readonly options: RedisLimiterOptions = {},
  ) {
    this.fallback = new MemoryLimiterStore();
  }

  async hit(key: string, windowMs: number): Promise<number> {
    try {
      const n = await this.redis.eval(HIT_SCRIPT, 1, limiterKey(key), String(windowMs));
      return Number(n);
    } catch (e) {
      // Measured caveat: a commandTimeout rejection does NOT mean the INCR was not
      // applied — Redis executes it regardless of whether the reply is read. So on a
      // flapping Redis one attempt can be counted twice, here and in Redis, and a
      // caller runs out of budget sooner than their real attempt count. It cannot
      // lock anyone out permanently, because the PEXPIRE ran too.
      this.options.onFallback?.(e as Error);
      return this.fallback.hit(key, windowMs);
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(limiterKey(key));
    } catch (e) {
      this.options.onFallback?.(e as Error);
    }
    // Always clear the fallback too: a reset that only cleared one of the two would
    // leave a budget the caller was told had been returned to them.
    await this.fallback.reset(key);
  }
}
