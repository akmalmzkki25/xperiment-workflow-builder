import { DEFAULT_DATABASE_URL, DEFAULT_REDIS_URL } from '@xperiment/db';
import { describe, expect, test } from 'vitest';
import { dependenciesOf, preflightMessage, unreachable, type Dependency } from '../src/preflight.js';

describe('dependenciesOf', () => {
  test('falls back to the same defaults the services use', () => {
    // The duplicate in preflight.ts exists so this script does not load pg and the KMS
    // client to learn a hostname. This assertion is what keeps it from drifting.
    const deps = dependenciesOf({});
    expect(deps).toEqual([
      { name: 'postgres', host: new URL(DEFAULT_DATABASE_URL).hostname, port: 5432 },
      { name: 'redis', host: new URL(DEFAULT_REDIS_URL).hostname, port: 6379 },
    ]);
  });

  test('reads a configured host and port', () => {
    const deps = dependenciesOf({
      DATABASE_URL: 'postgresql://u:p@db.internal:6000/q',
      REDIS_URL: 'redis://cache.internal:6390/0',
    });
    expect(deps).toEqual([
      { name: 'postgres', host: 'db.internal', port: 6000 },
      { name: 'redis', host: 'cache.internal', port: 6390 },
    ]);
  });

  test('supplies the protocol default when a URL omits the port', () => {
    expect(dependenciesOf({ DATABASE_URL: 'postgresql://u:p@db.internal/q' })[0]).toEqual({
      name: 'postgres',
      host: 'db.internal',
      port: 5432,
    });
  });

  test('an unparseable URL yields nothing rather than a guess', () => {
    // The service that owns the variable reports the real problem far better than a
    // preflight can, and probing a guessed host would report the wrong one.
    expect(dependenciesOf({ DATABASE_URL: 'not a url', REDIS_URL: 'also not' })).toEqual([]);
  });

  test('de-brackets an IPv6 host', () => {
    expect(dependenciesOf({ DATABASE_URL: 'postgresql://u:p@[::1]:5432/q' })[0]!.host).toBe('::1');
  });
});

describe('unreachable', () => {
  const deps: Dependency[] = [
    { name: 'postgres', host: 'h', port: 1 },
    { name: 'redis', host: 'h', port: 2 },
  ];

  test('reports only what failed to answer', async () => {
    expect(await unreachable(deps, async (_h, p) => p === 1)).toEqual([deps[1]]);
  });

  test('everything up reports nothing', async () => {
    expect(await unreachable(deps, async () => true)).toEqual([]);
  });

  test('probes concurrently, not one timeout after another', async () => {
    let live = 0;
    let peak = 0;
    await unreachable(deps, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return false;
    });
    expect(peak).toBe(2);
  });
});

describe('preflightMessage', () => {
  test('says nothing when everything is up', () => {
    expect(preflightMessage([])).toBeNull();
  });

  test('names what is down and the command that fixes it', () => {
    // Without this, a stopped Docker Desktop is five interleaved connection stack traces
    // and the actual instruction appears nowhere.
    const msg = preflightMessage([{ name: 'postgres', host: 'localhost', port: 5432 }])!;
    expect(msg).toContain('postgres at localhost:5432');
    expect(msg).toContain('docker compose up -d');
  });
});
