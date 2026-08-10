import { register as globalRegister } from 'prom-client';
import { describe, expect, test } from 'vitest';
import { createMetrics } from '../src/metrics.js';

describe('createMetrics', () => {
  test('can be called many times in one process without colliding', async () => {
    // The API suite builds roughly forty server instances. collectDefaultMetrics
    // against prom-client's global registry throws "metric already registered" on the
    // second call, so a global registry would take the whole suite down.
    const handles = Array.from({ length: 40 }, (_, i) => createMetrics({ serviceName: `svc-${i}` }));
    expect(handles).toHaveLength(40);
    expect(await handles[39]!.render()).toContain('service="svc-39"');
  });

  test('never writes to the shared global registry', async () => {
    // A global registry would also merge every service's series inside one process.
    const before = (await globalRegister.metrics()).length;
    createMetrics({ serviceName: 'isolated' });
    expect((await globalRegister.metrics()).length).toBe(before);
  });

  test('two registries do not see each other', async () => {
    const a = createMetrics({ serviceName: 'a' });
    const b = createMetrics({ serviceName: 'b' });
    expect(await a.render()).not.toContain('service="b"');
    expect(await b.render()).not.toContain('service="a"');
  });

  test('a gauge is read at scrape time, not at registration', async () => {
    let reads = 0;
    const handle = createMetrics({
      serviceName: 'svc',
      gauges: [{ name: 'xperiment_test_depth', help: 'test', collect: () => ++reads }],
    });
    expect(reads).toBe(0);
    // Rendered with the registry's default labels attached.
    expect(await handle.render()).toContain('xperiment_test_depth{service="svc"} 1');
    expect(reads).toBe(1);
  });

  test('a gauge that throws costs its own series, not the whole scrape', async () => {
    const handle = createMetrics({
      serviceName: 'svc',
      gauges: [
        {
          name: 'xperiment_broken',
          help: 'broken',
          collect: () => {
            throw new Error('database is gone');
          },
        },
      ],
    });
    const body = await handle.render();
    expect(body).toContain('process_cpu_user_seconds_total');
    expect(body).not.toContain('database is gone');
  });

  test('the exposition content type is the one Prometheus expects', () => {
    expect(createMetrics({ serviceName: 'svc' }).contentType).toContain('text/plain');
  });
});
