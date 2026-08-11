import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { OPENAPI_DOCUMENT } from '../src/openapi.js';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
const registered: { method: string; url: string }[] = [];

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({
    pool,
    registry: createDefaultRegistry(),
    rateLimitPerMinute: 1,
    onRoute: (r) => registered.push(r),
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Fastify writes `/v1/workflows/:id`; OpenAPI writes `/v1/workflows/{id}`. */
function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Verbs that exist without anyone declaring them.
 *
 * Fastify adds HEAD for every GET, and @fastify/cors adds OPTIONS. Documenting either
 * would be noise, and asserting on them would make the test fail for reasons nobody
 * wrote.
 */
const IMPLICIT_METHODS = new Set(['HEAD', 'OPTIONS']);

/**
 * Routes deliberately outside the documented surface.
 *
 * Kept as an explicit list with reasons rather than a pattern, so adding to it is a
 * decision somebody makes on purpose.
 */
const UNDOCUMENTED: readonly string[] = [
  // The document describing the document.
  'GET /v1/openapi.json',
];

const documented = new Set<string>();
for (const [path, ops] of Object.entries(OPENAPI_DOCUMENT.paths as Record<string, Record<string, unknown>>)) {
  for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${path}`);
}

function publicSurface(): string[] {
  return registered
    .filter((r) => r.url.startsWith('/v1/'))
    .filter((r) => !IMPLICIT_METHODS.has(r.method))
    .map((r) => `${r.method} ${toOpenApiPath(r.url)}`)
    .filter((entry) => !UNDOCUMENTED.includes(entry));
}

describe('the OpenAPI document tracks the routes', () => {
  test('the route enumeration actually found routes', () => {
    // Without this, a broken seam would make every assertion below vacuously pass.
    expect(registered.length).toBeGreaterThan(30);
    expect(publicSurface().length).toBeGreaterThan(30);
  });

  test('every registered /v1 route is documented', () => {
    // The old test named five paths, so the document drifted silently every time a route
    // landed. PUT /v1/connections/{id} was added in this same batch and would have been
    // missed.
    const missing = publicSurface().filter((entry) => !documented.has(entry));
    expect(missing, `undocumented routes:\n${missing.join('\n')}`).toEqual([]);
  });

  test('every documented path and method actually exists', () => {
    // The other direction: a route deleted or renamed leaves a lie in the document, and
    // a client written against it gets a 404 with no explanation.
    const live = new Set(
      registered.filter((r) => !IMPLICIT_METHODS.has(r.method)).map((r) => `${r.method} ${toOpenApiPath(r.url)}`),
    );
    const phantom = [...documented].filter((entry) => !live.has(entry));
    expect(phantom, `documented but not registered:\n${phantom.join('\n')}`).toEqual([]);
  });

  test('every documented operation carries a summary and a tag', () => {
    const thin: string[] = [];
    for (const [path, ops] of Object.entries(OPENAPI_DOCUMENT.paths as Record<string, Record<string, unknown>>)) {
      for (const [method, op] of Object.entries(ops)) {
        const o = op as { summary?: string; tags?: string[] };
        if (!o.summary || o.summary.trim() === '') thin.push(`${method.toUpperCase()} ${path}: no summary`);
        if (!o.tags || o.tags.length === 0) thin.push(`${method.toUpperCase()} ${path}: no tag`);
      }
    }
    expect(thin, thin.join('\n')).toEqual([]);
  });
});

describe('GET /v1/openapi.json', () => {
  test('is public, parses, and documents the key paths', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    const doc = JSON.parse(r.body) as { openapi: string; paths: Record<string, unknown>; components: unknown };
    expect(doc.openapi).toBe('3.1.0');
    for (const path of [
      '/v1/executions/{id}/retry',
      '/v1/executions/{id}/cancel',
      '/v1/workflows/{id}/callback',
      '/v1/workflows',
      '/v1/connectors',
    ]) {
      expect(doc.paths[path]).toBeDefined();
    }
  });

  test('is not rate-limited even at a tiny limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});
