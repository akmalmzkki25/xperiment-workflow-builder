import { describe, expect, test } from 'vitest';
import { DEFAULT_DATABASE_URL } from '../src/pool.js';
import {
  assertSeedable,
  fakeHost,
  fakeSecret,
  isFakeCredential,
  seedRefusals,
} from '../src/seed/guard.js';

const DEV = { NODE_ENV: 'development', DATABASE_URL: DEFAULT_DATABASE_URL };

describe('seedRefusals', () => {
  test('a local development stack is allowed', () => {
    expect(seedRefusals(DEV)).toEqual([]);
  });

  test('production is refused', () => {
    expect(seedRefusals({ ...DEV, NODE_ENV: 'production' }).map((r) => r.gate)).toContain('NODE_ENV');
  });

  test('a CONFIGURED database is refused, which is the inversion that matters', () => {
    // A database counts as development because it still carries the committed
    // credential. The moment someone configured a real one, this stops passing — so
    // the dangerous case is the one that looks properly set up.
    const configured = { ...DEV, DATABASE_URL: 'postgresql://xperiment:strong@db.internal:5432/xperiment' };
    const gates = seedRefusals(configured);
    expect(gates.map((r) => r.gate)).toContain('DATABASE_URL');
    expect(gates.some((r) => r.detail.includes('configured by someone'))).toBe(true);
  });

  test('a remote host is refused even with the development password', () => {
    const remote = { ...DEV, DATABASE_URL: 'postgresql://postgres:dev_password_change_me@db.internal:5432/xperiment' };
    expect(seedRefusals(remote).some((r) => r.detail.includes('other than this machine'))).toBe(true);
  });

  test('an unparseable URL is refused rather than assumed local', () => {
    expect(seedRefusals({ ...DEV, DATABASE_URL: 'not a url' }).length).toBeGreaterThan(0);
  });

  test('every reason is reported at once', () => {
    const bad = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@prod.internal:5432/xperiment' };
    expect(seedRefusals(bad).length).toBeGreaterThanOrEqual(3);
  });

  test('force clears the gates, and exists only as a flag', () => {
    // Deliberately not an environment variable: an override has to be typed by a
    // person at the moment they mean it, not inherited from a shell profile.
    const bad = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@prod.internal:5432/xperiment' };
    expect(seedRefusals(bad, { force: true })).toEqual([]);
  });
});

describe('assertSeedable', () => {
  test('throws listing every gate', () => {
    expect(() => assertSeedable({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@prod:5432/q' })).toThrow(
      /NODE_ENV[\s\S]*DATABASE_URL/,
    );
  });

  test('does not throw on a local development stack', () => {
    expect(() => assertSeedable(DEV)).not.toThrow();
  });

  test('never echoes the password back', () => {
    try {
      assertSeedable({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:hunter2@prod:5432/q' });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });
});

describe('fabricated credentials', () => {
  test('are loud, so nobody spends an afternoon rotating one', () => {
    expect(fakeSecret('telegram')).toContain('FAKE');
    expect(isFakeCredential(fakeSecret('telegram'))).toBe(true);
  });

  test('use a TLD that can never resolve', () => {
    // RFC 2606 reserves .invalid, so a demo connection cannot reach anything real.
    expect(fakeHost('api')).toMatch(/\.invalid$/);
    expect(isFakeCredential(fakeHost('api'))).toBe(true);
  });

  test('a real-looking value is not mistaken for a fake one', () => {
    expect(isFakeCredential('sk-live-9f3c2a')).toBe(false);
    expect(isFakeCredential('https://api.telegram.org')).toBe(false);
  });
});
