const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

interface Window {
  count: number;
  startedAt: number;
}

/** Fixed-window in-memory login limiter (per email+ip). Redis-backed later. */
export class LoginLimiter {
  private readonly windows = new Map<string, Window>();

  /** Returns true when the attempt is allowed. */
  check(key: string, now: number = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.startedAt >= WINDOW_MS) {
      this.windows.set(key, { count: 1, startedAt: now });
      return true;
    }
    w.count += 1;
    return w.count <= MAX_ATTEMPTS;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }
}
