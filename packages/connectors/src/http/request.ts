import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { assertUrlAllowed } from './ssrf.js';

const paramsSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  })
  .strict();

export function createHttpRequest(cfg: { allowPrivateIps: boolean }): ConnectorDefinition {
  return {
    type: 'http.request',
    kind: 'action',
    operationVersion: '0.1.0',
    defaultEffectClass: 'write',
    outputPorts: ['main'],
    display: {
      displayName: 'HTTP request',
      description: 'Call any HTTP API and use its response.',
      category: 'Integrations',
      glyph: '⇄',
    },
    paramsSchema,
    async run(ctx) {
      const parsed = paramsSchema.safeParse(ctx.parameters);
      if (!parsed.success) {
        throw new NodeRunError('invalid_parameters', parsed.error.message, false);
      }
      const p = parsed.data;
      await assertUrlAllowed(p.url, { allowPrivate: cfg.allowPrivateIps });

      const url = new URL(p.url);
      for (const [k, v] of Object.entries(p.query ?? {})) url.searchParams.set(k, v);

      const headers: Record<string, string> = { ...(p.headers ?? {}) };
      const hasBody = p.body !== undefined && p.method !== 'GET' && p.method !== 'HEAD';
      if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: p.method,
          headers,
          body: hasBody ? JSON.stringify(p.body) : undefined,
          signal: ctx.signal,
          redirect: 'follow',
        });
      } catch (e) {
        if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
          throw new NodeRunError('timeout', 'HTTP request timed out', false, { timeout: true });
        }
        throw new NodeRunError('network_error', `HTTP request failed: ${(e as Error).message}`, true);
      }

      const raw = await res.text();
      let body: unknown = raw;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        /* keep raw string */
      }
      const resHeaders = Object.fromEntries(res.headers.entries());

      if (!res.ok) {
        throw new NodeRunError('http_error', `HTTP ${res.status} from ${url.hostname}`, false, {
          httpStatus: res.status,
          body,
        });
      }
      return { output: { status: res.status, headers: resHeaders, body } };
    },
  };
}
