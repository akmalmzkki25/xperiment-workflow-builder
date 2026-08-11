import { resolveDatabaseUrl, usesDevelopmentDefaults } from '../pool.js';

/**
 * Gates on `xperiment seed`, all of which fail CLOSED.
 *
 * Seeding writes fabricated workspaces, workflows and run history. Against a
 * developer's local stack that is the entire point; against anything else it is
 * fabricated data in a real customer's account, and there is no undo.
 */

export interface SeedEnv {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
}

export interface SeedRefusal {
  gate: string;
  detail: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * Every reason to refuse, as data.
 *
 * The second gate reads backwards on purpose, and that inversion IS the design. A
 * database counts as development because it still carries the committed development
 * credential. The moment someone has configured a real one, the check stops passing —
 * so the dangerous case is the one that looks properly set up, and it is refused by
 * default rather than allowed by default.
 */
export function seedRefusals(env: SeedEnv, opts: { force?: boolean } = {}): SeedRefusal[] {
  const refusals: SeedRefusal[] = [];

  if (env.NODE_ENV === 'production') {
    refusals.push({ gate: 'NODE_ENV', detail: 'is production' });
  }

  const url = resolveDatabaseUrl(env.DATABASE_URL);
  if (!usesDevelopmentDefaults(env.DATABASE_URL)) {
    refusals.push({
      gate: 'DATABASE_URL',
      detail: 'is not the committed development credential, so this database was configured by someone',
    });
  }

  const host = hostOf(url);
  if (host === null) {
    refusals.push({ gate: 'DATABASE_URL', detail: 'could not be parsed, so its host cannot be checked' });
  } else if (!LOCAL_HOSTS.has(host) && !host.startsWith('127.')) {
    refusals.push({ gate: 'DATABASE_URL', detail: 'points somewhere other than this machine' });
  }

  // --force overrides the environment gates. It deliberately does NOT exist as an
  // environment variable: an override has to be typed by a person at the moment they
  // mean it, not inherited from a shell profile or a CI job someone forgot about.
  return opts.force ? [] : refusals;
}

export function assertSeedable(env: SeedEnv = process.env, opts: { force?: boolean } = {}): void {
  const refusals = seedRefusals(env, opts);
  if (refusals.length === 0) return;
  const lines = refusals.map((r) => `  - ${r.gate}: ${r.detail}`).join('\n');
  throw new Error(`Refusing to seed demo data:\n${lines}\n\nPass --force only if you are certain.`);
}

/**
 * The marker every fabricated credential must carry.
 *
 * Loud on purpose. A demo secret that looks like a real one ends up in a bug report,
 * a screenshot, or a support ticket, and somebody spends an afternoon rotating it.
 */
export const FAKE_MARKER = 'FAKE';

/** RFC 2606 reserves `.invalid`; it can never resolve, so a demo cannot call out. */
export function fakeSecret(label: string): string {
  return `${FAKE_MARKER}-${label}-not-a-real-credential`;
}

export function fakeHost(label: string): string {
  return `${label}.${FAKE_MARKER.toLowerCase()}.invalid`;
}

/** True when a value is unmistakably seeded rather than real. */
export function isFakeCredential(value: string): boolean {
  return value.includes(FAKE_MARKER) || value.includes('.invalid');
}
