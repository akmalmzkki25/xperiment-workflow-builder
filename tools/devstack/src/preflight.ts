import { createConnection } from 'node:net';

/**
 * Checks the two backing services are reachable before starting anything.
 *
 * Without it, a stopped Docker Desktop produces five near-identical connection stack
 * traces interleaved across five log prefixes, and the actual instruction — start the
 * containers — is nowhere in the output.
 */

/**
 * Duplicated from `@xperiment/db` rather than imported: loading that package to learn a
 * hostname would pull in `pg` and the KMS client for a two-line check. The test asserts
 * these still match the real exports, which is what keeps the duplicate honest.
 */
const DEFAULT_DATABASE_URL = 'postgresql://postgres:dev_password_change_me@localhost:5432/xperiment';
const DEFAULT_REDIS_URL = 'redis://:dev_password_change_me@localhost:6379/0';

export interface Dependency {
  name: string;
  host: string;
  port: number;
}

function endpointOf(name: string, url: string, fallbackPort: number): Dependency | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (host === '') return null;
    const port = parsed.port === '' ? fallbackPort : Number(parsed.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? { name, host, port } : null;
  } catch {
    return null;
  }
}

/**
 * What must be listening. A URL we cannot parse yields nothing rather than a guess: the
 * service that owns it will report the real problem far better than this script can.
 */
export function dependenciesOf(env: Readonly<Record<string, string | undefined>>): Dependency[] {
  const out: Dependency[] = [];
  const db = endpointOf('postgres', env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, 5432);
  const redis = endpointOf('redis', env['REDIS_URL'] ?? DEFAULT_REDIS_URL, 6379);
  if (db) out.push(db);
  if (redis) out.push(redis);
  return out;
}

export type Probe = (host: string, port: number) => Promise<boolean>;

/** A TCP connect, nothing more. A handshake would need two protocol clients. */
export const tcpProbe: Probe = (host, port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });

export async function unreachable(deps: readonly Dependency[], probe: Probe = tcpProbe): Promise<Dependency[]> {
  // Probed together: two sequential 1.5s timeouts is three seconds of a dev staring at
  // nothing before being told what is wrong.
  const results = await Promise.all(deps.map(async (d) => ({ d, ok: await probe(d.host, d.port) })));
  return results.filter((r) => !r.ok).map((r) => r.d);
}

export function preflightMessage(missing: readonly Dependency[]): string | null {
  if (missing.length === 0) return null;
  const list = missing.map((d) => `  - ${d.name} at ${d.host}:${d.port}`).join('\n');
  return `Cannot reach:\n${list}\n\nStart them first:\n  docker compose up -d`;
}
