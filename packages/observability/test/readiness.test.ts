import { describe, expect, test, vi } from 'vitest';
import { createReadiness, postgresDependency, redisDependency, type Dependency } from '../src/readiness.js';

const up = (name: string, critical = true): Dependency => ({ name, critical, probe: async () => undefined });
const down = (name: string, critical = true, message = 'ECONNREFUSED'): Dependency => ({
  name,
  critical,
  probe: async () => {
    throw new Error(message);
  },
});

describe('createReadiness', () => {
  test('everything up is ok', async () => {
    const report = await createReadiness([up('postgres'), up('redis', false)])();
    expect(report.status).toBe('ok');
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  test('a critical dependency down is down', async () => {
    const report = await createReadiness([down('postgres')])();
    expect(report.status).toBe('down');
    expect(report.checks[0]!.error).toContain('ECONNREFUSED');
  });

  test('a NON-critical dependency down is degraded, not down', async () => {
    // An API that cannot reach Redis still serves every read route. Pulling all its
    // replicas out of the load balancer would turn a partial outage into a total one.
    const report = await createReadiness([up('postgres'), down('redis', false)])();
    expect(report.status).toBe('degraded');
  });

  test('the same dependency can be critical elsewhere', async () => {
    // A worker without Redis does nothing at all.
    expect((await createReadiness([down('redis', true)])()).status).toBe('down');
  });

  test('a probe that never settles fails rather than hanging the endpoint', async () => {
    const hang: Dependency = { name: 'postgres', critical: true, probe: () => new Promise(() => {}) };
    const report = await createReadiness([hang], { probeTimeoutMs: 20 })();
    expect(report.status).toBe('down');
    expect(report.checks[0]!.error).toContain('timed out');
  });

  test('a failure reports only the message, never the driver error object', async () => {
    const leaky: Dependency = {
      name: 'postgres',
      critical: true,
      probe: async () => {
        const e = new Error('connection refused') as Error & { connectionString: string };
        e.connectionString = 'postgresql://xperiment:hunter2@db:5432/xperiment';
        throw e;
      },
    };
    const report = await createReadiness([leaky])();
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  test('results are cached, so a probe storm is not a database storm', async () => {
    // Unauthenticated /readyz that probes on every request is a 1:1 amplifier onto a
    // database that is, by hypothesis, already struggling.
    const probe = vi.fn(async () => undefined);
    let clock = 0;
    const readiness = createReadiness([{ name: 'postgres', critical: true, probe }], {
      cacheMs: 1000,
      now: () => clock,
    });
    await readiness();
    await readiness();
    await readiness();
    expect(probe).toHaveBeenCalledTimes(1);

    clock = 1001;
    await readiness();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('concurrent callers share one in-flight round', async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const readiness = createReadiness([
      {
        name: 'postgres',
        critical: true,
        probe: async () => {
          started += 1;
          await gate;
        },
      },
    ]);
    const all = Promise.all([readiness(), readiness(), readiness(), readiness()]);
    release();
    const reports = await all;
    expect(started).toBe(1);
    expect(reports.every((r) => r.status === 'ok')).toBe(true);
  });

  test('an empty dependency list is ok, not a crash', async () => {
    expect((await createReadiness([])()).status).toBe('ok');
  });
});

describe('dependency helpers', () => {
  test('postgres runs a real statement rather than checking a socket', async () => {
    const seen: string[] = [];
    const dep = postgresDependency({ query: async (sql: string) => void seen.push(sql) });
    await dep.probe();
    expect(seen).toEqual(['SELECT 1']);
    expect(dep.critical).toBe(true);
  });

  test('redis pings, and its criticality is the caller decision', async () => {
    const dep = redisDependency({ ping: async () => 'PONG' }, false);
    await expect(dep.probe()).resolves.toBe('PONG');
    expect(dep.critical).toBe(false);
  });
});
