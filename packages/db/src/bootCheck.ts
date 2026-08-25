import { DEFAULT_DATABASE_URL, resolveDatabaseUrl } from './pool.js';

/**
 * Boot-time environment checks that fail CLOSED.
 *
 * The dev stack ships with a committed database password and a committed Redis
 * password, which is the right call for `docker compose up` and a catastrophe if a
 * deployment inherits them. Nothing today notices: a service pointed at a production
 * host with no DATABASE_URL set falls back to localhost and starts perfectly, then
 * serves an empty database.
 *
 * Only enforced when NODE_ENV is 'production'. Development and test keep their
 * defaults, because a check that fires in the suite is a check people delete.
 */

export const DEFAULT_REDIS_URL = 'redis://:dev_password_change_me@localhost:6379/0';

export interface BootCheckEnv {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
  REDIS_URL?: string | undefined;
  KMS_KEY_URI?: string | undefined;
  XPERIMENT_MASTER_KEY?: string | undefined;
  /** Pre-rename name, still honoured so a deploy is not silently downgraded. */
  XPERIMENT_MASTER_KEY?: string | undefined;
}

export interface BootProblem {
  variable: string;
  detail: string;
}

function isLocalHost(url: string): boolean {
  try {
    // Lowercased and de-bracketed: WHATWG only normalises the host for "special"
    // schemes, and postgresql:// is not one — so `LOCALHOST` stays uppercase and an
    // IPv6 loopback arrives as `[::1]`. Both slipped straight past a bare comparison.
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.');
  } catch {
    // An unparseable URL is its own problem, reported by the caller.
    return false;
  }
}

/**
 * Problems that should stop a production boot, as data rather than throws.
 *
 * Returned as a list so the operator sees EVERY misconfiguration at once. Throwing on
 * the first turns fixing three variables into three deploys.
 */
export function bootProblems(env: BootCheckEnv): BootProblem[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: BootProblem[] = [];

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    problems.push({ variable: 'DATABASE_URL', detail: 'unset, so the committed development database would be used' });
  } else if (databaseUrl === DEFAULT_DATABASE_URL) {
    problems.push({ variable: 'DATABASE_URL', detail: 'is the committed development credential' });
  } else if (isLocalHost(databaseUrl)) {
    problems.push({ variable: 'DATABASE_URL', detail: 'points at localhost' });
  }

  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    problems.push({ variable: 'REDIS_URL', detail: 'unset, so the committed development Redis would be used' });
  } else if (redisUrl === DEFAULT_REDIS_URL) {
    problems.push({ variable: 'REDIS_URL', detail: 'is the committed development credential' });
  } else if (isLocalHost(redisUrl)) {
    problems.push({ variable: 'REDIS_URL', detail: 'points at localhost' });
  }

  // Envelope encryption needs a key from somewhere. Without either, the vault would
  // fall back to a development key and seal every workspace secret under it.
  if (!env.KMS_KEY_URI && !env.XPERIMENT_MASTER_KEY && !env.XPERIMENT_MASTER_KEY) {
    problems.push({
      variable: 'KMS_KEY_URI',
      detail: 'unset with no XPERIMENT_MASTER_KEY either, so workspace secrets would be sealed with a development key',
    });
  }

  return problems;
}

/** Throws with every problem listed, or returns quietly. */
export function assertBootSafe(env: BootCheckEnv = process.env): void {
  const problems = bootProblems(env);
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  - ${p.variable}: ${p.detail}`).join('\n');
  throw new Error(`Refusing to start in production with an unsafe environment:\n${lines}`);
}

export { resolveDatabaseUrl };
