import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { MetricsHandle } from './metrics.js';
import type { ReadinessReport } from './readiness.js';

export interface AdminServerOptions {
  port: number;
  serviceName: string;
  readiness: () => Promise<ReadinessReport>;
  metrics?: MetricsHandle | undefined;
  /**
   * Required for /metrics to exist at all.
   *
   * Absent means the route is NOT REGISTERED — a 404, not an open endpoint. A missing
   * token must never be read as "no protection needed"; that is how an internal
   * surface ends up public because someone forgot an environment variable.
   */
  metricsToken?: string | undefined;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface AdminServer {
  port: number;
  close(): Promise<void>;
}

/** Constant-time, and length-safe: timingSafeEqual throws on a length mismatch. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.end(body);
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) return null;
  return rest.join(' ');
}

/**
 * The operational surface: liveness, readiness, and optionally metrics.
 *
 * Replaces health servers that answered ANY path with 200 — which meant every probe
 * was green as long as the process existed, including with its database gone. Unknown
 * paths are now 404, which is the point and is also why the e2e callers that polled
 * the bare root had to move to /healthz in the same change.
 *
 * Liveness and readiness are deliberately different questions. /healthz asks "is this
 * process running" and must not touch a dependency, or a database blip restarts every
 * container in the fleet. /readyz asks "can it do its job" and is what a load balancer
 * should use to stop sending traffic.
 */
export function startAdminServer(opts: AdminServerOptions): Promise<AdminServer> {
  const log = opts.log ?? (() => {});
  const metricsEnabled = opts.metrics !== undefined && (opts.metricsToken ?? '').length > 0;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/healthz') {
      send(res, 200, JSON.stringify({ status: 'ok', service: opts.serviceName }));
      return;
    }

    if (path === '/readyz') {
      void opts
        .readiness()
        .then((report) => {
          // 503 on `down` only. A degraded service is still worth sending traffic to;
          // pulling every replica because a non-critical dependency blinked turns a
          // partial outage into a total one.
          send(res, report.status === 'down' ? 503 : 200, JSON.stringify(report));
        })
        .catch((e: unknown) => {
          send(res, 503, JSON.stringify({ status: 'down', error: (e as Error).message, checks: [] }));
        });
      return;
    }

    if (path === '/metrics') {
      if (!metricsEnabled) {
        send(res, 404, JSON.stringify({ error: 'not found' }));
        return;
      }
      const token = bearerOf(req);
      if (token === null || !tokenMatches(token, opts.metricsToken as string)) {
        res.setHeader('www-authenticate', 'Bearer');
        send(res, 401, JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      void (opts.metrics as MetricsHandle)
        .render()
        .then((body) => send(res, 200, body, (opts.metrics as MetricsHandle).contentType))
        .catch((e: unknown) => send(res, 500, JSON.stringify({ error: (e as Error).message })));
      return;
    }

    send(res, 404, JSON.stringify({ error: 'not found' }));
  });

  return new Promise<AdminServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      log('admin.listening', { service: opts.serviceName, port, metrics: metricsEnabled });
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
