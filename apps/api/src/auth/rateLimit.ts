import { MemoryLimiterStore, type LimiterStore } from '@xperiment/queue';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Fixed-window login limiter, per email+ip.
 *
 * Async because the counter may live in Redis: in process it was per-replica state, so
 * a cap of five attempts silently became five times the replica count. The default is
 * still in memory — Redis is opted into at the composition root only, or the test
 * suite would leave counters in a shared Redis DB and two consecutive runs would
 * disagree.
 */
export class LoginLimiter {
  constructor(private readonly store: LimiterStore = new MemoryLimiterStore()) {}

  /** True when the attempt is allowed. */
  async check(key: string): Promise<boolean> {
    return (await this.store.hit(key, WINDOW_MS)) <= MAX_ATTEMPTS;
  }

  async reset(key: string): Promise<void> {
    await this.store.reset(key);
  }
}

export { MAX_ATTEMPTS, WINDOW_MS };
