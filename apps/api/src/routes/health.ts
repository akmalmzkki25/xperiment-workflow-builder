import { createReadiness, postgresDependency, redisDependency } from '@xperiment/observability';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export interface HealthDeps {
  pool: pg.Pool;
  /** Optional: the API answers every read route without it. */
  redis?: { ping: () => Promise<string> } | undefined;
}

export function registerHealthRoutes(app: FastifyInstance, deps?: HealthDeps): void {
  // Liveness. Deliberately touches nothing — a database blip must not make an
  // orchestrator restart every API container. Body shape is frozen: a test asserts it
  // exactly, and a probe is not the place to start returning new fields.
  app.get('/v1/healthz', async () => ({ status: 'ok' }));

  if (!deps) return;

  const readiness = createReadiness([
    postgresDependency(deps.pool),
    // Redis is NON-critical for the API. It serves every read route without it, and
    // pulling all replicas out of the load balancer because Redis blinked turns a
    // partial outage into a total one.
    ...(deps.redis ? [redisDependency(deps.redis, false)] : []),
  ]);

  app.get('/v1/readyz', async (_req, reply) => {
    const report = await readiness();
    if (report.status === 'down') reply.status(503);
    return report;
  });
}
