import { afterEach, describe, expect, test } from 'vitest';
import { startAdminServer, type AdminServer } from '../src/adminServer.js';
import { createMetrics } from '../src/metrics.js';
import { createReadiness, type Dependency } from '../src/readiness.js';

let server: AdminServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const up: Dependency = { name: 'postgres', critical: true, probe: async () => undefined };
const down: Dependency = {
  name: 'postgres',
  critical: true,
  probe: async () => {
    throw new Error('ECONNREFUSED');
  },
};

async function start(overrides: Partial<Parameters<typeof startAdminServer>[0]> = {}): Promise<string> {
  server = await startAdminServer({
    port: 0,
    serviceName: 'test',
    readiness: createReadiness([up], { cacheMs: 0 }),
    ...overrides,
  });
  return `http://127.0.0.1:${server.port}`;
}

describe('liveness and readiness', () => {
  test('healthz is 200 and does not consult a dependency', async () => {
    // Liveness must not touch the database, or a blip restarts every container.
    let probed = false;
    const base = await start({
      readiness: createReadiness([
        { name: 'postgres', critical: true, probe: async () => void (probed = true) },
      ]),
    });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'test' });
    expect(probed).toBe(false);
  });

  test('readyz is 200 when up and 503 when a critical dependency is down', async () => {
    let base = await start();
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    await server!.close();
    server = null;

    base = await start({ readiness: createReadiness([down], { cacheMs: 0 }) });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe('down');
  });

  test('degraded still serves traffic', async () => {
    const base = await start({
      readiness: createReadiness([up, { ...down, name: 'redis', critical: false }], { cacheMs: 0 }),
    });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('degraded');
  });

  test('an unknown path is 404, not a cheerful 200', async () => {
    // Three services used to answer ANY path with {status:'ok'}, so every probe was
    // green as long as the process existed.
    const base = await start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/nonsense`)).status).toBe(404);
  });

  test('a readiness function that throws is 503, not an unhandled rejection', async () => {
    const base = await start({
      readiness: async () => {
        throw new Error('probe machinery broke');
      },
    });
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });
});

describe('metrics', () => {
  const metrics = () => createMetrics({ serviceName: 'test' });

  test('without a token the route does not exist at all', async () => {
    // A missing token must never read as "no protection needed".
    const base = await start({ metrics: metrics() });
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });

  test('with a token, no bearer is 401', async () => {
    const base = await start({ metrics: metrics(), metricsToken: 'secret-token' });
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('a wrong token is 401 and leaks nothing', async () => {
    const base = await start({ metrics: metrics(), metricsToken: 'secret-token' });
    const res = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('secret-token');
  });

  test('a token of a different length is refused rather than throwing', async () => {
    // timingSafeEqual throws on a length mismatch; the guard has to come first.
    const base = await start({ metrics: metrics(), metricsToken: 'secret-token' });
    expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer x' } })).status).toBe(401);
  });

  test('the right token renders the exposition format', async () => {
    const base = await start({ metrics: metrics(), metricsToken: 'secret-token' });
    const res = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer secret-token' } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('process_cpu_user_seconds_total');
    expect(body).toContain('service="test"');
  });
});
