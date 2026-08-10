import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';

export interface MetricsHandle {
  registry: Registry;
  /** Renders the exposition format. */
  render: () => Promise<string>;
  contentType: string;
}

export interface GaugeSpec {
  name: string;
  help: string;
  /** Read at scrape time, so nothing is computed unless someone is looking. */
  collect: () => Promise<number> | number;
}

/**
 * A metrics registry scoped to one service.
 *
 * ALWAYS a fresh `Registry`, never prom-client's global `register`. The default
 * registry is module state: `collectDefaultMetrics()` against it throws
 * "metric already registered" the second time it runs in a process, and the API test
 * suite builds roughly forty server instances. A global registry would also merge
 * every service's series in a shared process.
 */
export function createMetrics(opts: { serviceName: string; gauges?: readonly GaugeSpec[] }): MetricsHandle {
  const registry = new Registry();
  registry.setDefaultLabels({ service: opts.serviceName });
  collectDefaultMetrics({ register: registry });

  for (const spec of opts.gauges ?? []) {
    new Gauge({
      name: spec.name,
      help: spec.help,
      registers: [registry],
      async collect() {
        try {
          this.set(await spec.collect());
        } catch {
          // A gauge that cannot be read must not fail the whole scrape — losing one
          // series is better than losing every series including the process ones.
        }
      },
    });
  }

  return {
    registry,
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}
