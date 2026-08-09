import { describe, expect, test } from 'vitest';
import { assertBootSafe, bootProblems, DEFAULT_REDIS_URL } from '../src/bootCheck.js';
import { DEFAULT_DATABASE_URL } from '../src/pool.js';

const SAFE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://xperiment:strong@db.internal:5432/xperiment',
  REDIS_URL: 'redis://:strong@cache.internal:6379/0',
  KMS_KEY_URI: 'gcp-kms://projects/p/locations/l/keyRings/r/cryptoKeys/k',
};

describe('bootProblems', () => {
  test('says nothing outside production', () => {
    // A check that fires in the suite is a check people delete.
    expect(bootProblems({})).toEqual([]);
    expect(bootProblems({ NODE_ENV: 'development' })).toEqual([]);
    expect(bootProblems({ NODE_ENV: 'test' })).toEqual([]);
  });

  test('a fully configured production environment is silent', () => {
    expect(bootProblems(SAFE)).toEqual([]);
  });

  test('an unset DATABASE_URL in production is a problem, not a silent localhost fallback', () => {
    const problems = bootProblems({ ...SAFE, DATABASE_URL: undefined });
    expect(problems.map((p) => p.variable)).toContain('DATABASE_URL');
  });

  test('the committed development credentials are named as such', () => {
    expect(bootProblems({ ...SAFE, DATABASE_URL: DEFAULT_DATABASE_URL })[0]?.detail).toContain('development credential');
    expect(bootProblems({ ...SAFE, REDIS_URL: DEFAULT_REDIS_URL })[0]?.detail).toContain('development credential');
  });

  test('a production database on localhost is refused even with a different password', () => {
    const problems = bootProblems({ ...SAFE, DATABASE_URL: 'postgresql://u:p@localhost:5432/xperiment' });
    expect(problems.map((p) => p.variable)).toEqual(['DATABASE_URL']);
    expect(problems[0]!.detail).toContain('localhost');
  });

  test('either key source satisfies the encryption check', () => {
    expect(bootProblems({ ...SAFE, KMS_KEY_URI: undefined, XPERIMENT_MASTER_KEY: 'abc' })).toEqual([]);
    const missing = bootProblems({ ...SAFE, KMS_KEY_URI: undefined });
    expect(missing.map((p) => p.variable)).toContain('KMS_KEY_URI');
  });

  test('reports every problem at once rather than the first', () => {
    // Three variables to fix should be one deploy, not three.
    const problems = bootProblems({ NODE_ENV: 'production' });
    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.variable).sort()).toEqual(['DATABASE_URL', 'KMS_KEY_URI', 'REDIS_URL']);
  });

  test('localhost is caught however it is spelled', () => {
    // WHATWG only normalises the host for "special" schemes, and postgresql:// is not
    // one — LOCALHOST stays uppercase and IPv6 loopback arrives bracketed. Both used
    // to walk straight past.
    for (const host of ['LOCALHOST', 'LocalHost', '[::1]', '127.0.0.1', '127.10.0.5']) {
      const problems = bootProblems({ ...SAFE, DATABASE_URL: `postgresql://u:p@${host}:5432/xperiment` });
      expect(problems.map((p) => p.variable), host).toContain('DATABASE_URL');
    }
  });

  test('a production Redis on localhost is refused too', () => {
    const problems = bootProblems({ ...SAFE, REDIS_URL: 'redis://:realpassword@localhost:6379/0' });
    expect(problems.map((p) => p.variable)).toEqual(['REDIS_URL']);
  });

  test('a unix socket connection string is not mistaken for localhost', () => {
    expect(bootProblems({ ...SAFE, DATABASE_URL: 'postgresql:///xperiment?host=/var/run/postgresql' })).toEqual([]);
  });

  test('an unparseable DATABASE_URL is not treated as a safe remote host', () => {
    // It fails elsewhere, but it must not sneak past the localhost check.
    expect(bootProblems({ ...SAFE, DATABASE_URL: 'not a url' })).toEqual([]);
  });
});

describe('assertBootSafe', () => {
  test('throws listing every problem', () => {
    expect(() => assertBootSafe({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*KMS_KEY_URI/);
  });

  test('does not throw on a safe environment', () => {
    expect(() => assertBootSafe(SAFE)).not.toThrow();
  });

  test('never leaks the configured value into the message', () => {
    const secretUrl = 'postgresql://xperiment:hunter2@localhost:5432/xperiment';
    try {
      assertBootSafe({ ...SAFE, DATABASE_URL: secretUrl });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });
});
