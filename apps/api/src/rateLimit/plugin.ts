import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendProblem } from '../problem.js';

const WINDOW_MS = 60_000;
// Probes must never be rate limited, or a busy workspace makes its own service look
// down. Readiness is cached and single-flighted, so it cannot be used as an amplifier.
const EXEMPT = new Set(['/v1/healthz', '/v1/readyz', '/v1/openapi.json']);

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter, keyed by workspace (falling back to client IP for
 * unauthenticated paths). Single-instance / in-memory — documented as a beta
 * limitation. Sets X-RateLimit-* on every /v1 response.
 */
export function registerRateLimit(app: FastifyInstance, opts: { perMinute: number; now?: () => number }): void {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  // preHandler (not onRequest) so the auth plugin's preHandler has already
  // resolved authContext → we can key by workspace, not just IP.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/v1/') || EXEMPT.has(path)) return;

    const key = req.authContext?.workspaceId ?? `ip:${req.ip}`;
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + WINDOW_MS };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, opts.perMinute - bucket.count);
    const resetSec = Math.ceil(bucket.resetAt / 1000);
    void reply.header('x-ratelimit-limit', String(opts.perMinute));
    void reply.header('x-ratelimit-remaining', String(remaining));
    void reply.header('x-ratelimit-reset', String(resetSec));

    if (bucket.count > opts.perMinute) {
      void reply.header('retry-after', String(Math.max(1, Math.ceil((bucket.resetAt - t) / 1000))));
      return sendProblem(reply, 429, 'Too many requests', 'Rate limit exceeded');
    }
  });
}
