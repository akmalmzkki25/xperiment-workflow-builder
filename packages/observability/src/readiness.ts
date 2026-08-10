/**
 * Readiness that answers honestly and cannot be used as an amplifier.
 *
 * The services previously replied `{status:'ok'}` unconditionally — three of them to
 * literally any path — so a probe stayed green with Postgres on the floor. A real
 * probe has to touch its dependencies, which immediately makes an unauthenticated
 * endpoint a 1:1 lever on the database. Hence the cache and the single-flight.
 */

export interface Dependency {
  name: string;
  /**
   * False when the service can still do useful work without it.
   *
   * Deliberately asymmetric across services: an API that cannot reach Redis still
   * serves every read route, and pulling all its replicas out of the load balancer
   * because Redis blinked turns a partial outage into a total one. A worker without
   * Redis does nothing at all, so for the worker it is critical.
   */
  critical: boolean;
  probe: () => Promise<unknown>;
}

export interface DependencyResult {
  name: string;
  ok: boolean;
  critical: boolean;
  /** Present only when the probe failed. Never carries a connection string. */
  error?: string;
}

export interface ReadinessReport {
  /** `ok` everything up · `degraded` only non-critical down · `down` a critical one is. */
  status: 'ok' | 'degraded' | 'down';
  checks: DependencyResult[];
}

/** Long enough to absorb a probe storm, short enough that a real outage shows fast. */
export const DEFAULT_CACHE_MS = 1000;
/** A dependency that has not answered by now is not ready, whatever it is doing. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;

function statusOf(checks: DependencyResult[]): ReadinessReport['status'] {
  if (checks.some((c) => !c.ok && c.critical)) return 'down';
  if (checks.some((c) => !c.ok)) return 'degraded';
  return 'ok';
}

async function withTimeout(probe: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ReadinessOptions {
  cacheMs?: number;
  probeTimeoutMs?: number;
  /** Injectable so the cache is testable without sleeping. */
  now?: () => number;
}

/**
 * A readiness function that runs at most one probe round per cache window.
 *
 * Concurrent callers share the in-flight promise rather than each opening their own
 * connection: without that, N simultaneous probes are N round trips to a database
 * that is, by hypothesis, already in trouble.
 */
export function createReadiness(
  dependencies: readonly Dependency[],
  options: ReadinessOptions = {},
): () => Promise<ReadinessReport> {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let cached: { at: number; report: ReadinessReport } | null = null;
  let inFlight: Promise<ReadinessReport> | null = null;

  const runAll = async (): Promise<ReadinessReport> => {
    const checks = await Promise.all(
      dependencies.map(async (dep): Promise<DependencyResult> => {
        try {
          await withTimeout(dep.probe, probeTimeoutMs);
          return { name: dep.name, ok: true, critical: dep.critical };
        } catch (e) {
          // Only the message. A driver error can carry the connection string.
          return { name: dep.name, ok: false, critical: dep.critical, error: (e as Error).message };
        }
      }),
    );
    return { status: statusOf(checks), checks };
  };

  return async function readiness(): Promise<ReadinessReport> {
    const at = now();
    if (cached && at - cached.at < cacheMs) return cached.report;
    if (inFlight) return inFlight;
    inFlight = runAll()
      .then((report) => {
        cached = { at: now(), report };
        return report;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

/** Postgres is reachable and answering, not merely connectable. */
export function postgresDependency(
  pool: { query: (sql: string) => Promise<unknown> },
  critical = true,
): Dependency {
  return { name: 'postgres', critical, probe: () => pool.query('SELECT 1') };
}

export function redisDependency(redis: { ping: () => Promise<string> }, critical: boolean): Dependency {
  return { name: 'redis', critical, probe: () => redis.ping() };
}
