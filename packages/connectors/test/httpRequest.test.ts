import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDefaultRegistry, NodeRunError, type NodeRunContext } from '../src/index.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/ok') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ echoedQuery: url.searchParams.get('q'), echoedHeader: req.headers['x-test'] ?? null }),
      );
    } else if (url.pathname === '/echo-body') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body: JSON.parse(raw) }));
      });
    } else if (url.pathname === '/text') {
      res.setHeader('content-type', 'text/plain');
      res.end('plain text');
    } else if (url.pathname === '/fail-503') {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'unavailable' }));
    } else if (url.pathname === '/slow') {
      setTimeout(() => res.end('{}'), 2000);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// allowPrivateIps: true because the stub listens on 127.0.0.1
const registry = createDefaultRegistry({ allowPrivateIps: true });
const httpDef = () => registry.get('http.request')!;

function ctx(parameters: unknown, signal?: AbortSignal): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'call',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: signal ?? new AbortController().signal,
    log: () => {},
  };
}

describe('http.request', () => {
  test('GET with query and headers returns parsed JSON body', async () => {
    const r = await httpDef().run(
      ctx({ method: 'GET', url: `${baseUrl}/ok`, query: { q: 'hello' }, headers: { 'x-test': 'v1' } }),
    );
    const out = r.output as { status: number; body: { echoedQuery: string; echoedHeader: string } };
    expect(out.status).toBe(200);
    expect(out.body.echoedQuery).toBe('hello');
    expect(out.body.echoedHeader).toBe('v1');
  });

  test('POST sends JSON body', async () => {
    const r = await httpDef().run(ctx({ method: 'POST', url: `${baseUrl}/echo-body`, body: { name: 'Budi' } }));
    const out = r.output as { body: { method: string; body: { name: string } } };
    expect(out.body.method).toBe('POST');
    expect(out.body.body).toEqual({ name: 'Budi' });
  });

  test('non-JSON response body is returned as string', async () => {
    const r = await httpDef().run(ctx({ method: 'GET', url: `${baseUrl}/text` }));
    expect((r.output as { body: unknown }).body).toBe('plain text');
  });

  test('non-2xx throws NodeRunError with httpStatus in details', async () => {
    const err = await httpDef()
      .run(ctx({ method: 'GET', url: `${baseUrl}/fail-503` }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('http_error');
    expect(((err as NodeRunError).details as { httpStatus: number }).httpStatus).toBe(503);
  });

  test('abort produces timeout NodeRunError with details.timeout', async () => {
    const err = await httpDef()
      .run(ctx({ method: 'GET', url: `${baseUrl}/slow` }, AbortSignal.timeout(100)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('timeout');
    expect(((err as NodeRunError).details as { timeout: boolean }).timeout).toBe(true);
  });

  test('connection refused produces retryable network_error', async () => {
    const err = await httpDef()
      .run(ctx({ method: 'GET', url: 'http://127.0.0.1:1/unreachable' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('network_error');
    expect((err as NodeRunError).retryable).toBe(true);
  });

  test('SSRF guard blocks private IPs when allowPrivateIps is false', async () => {
    const guarded = createDefaultRegistry({ allowPrivateIps: false }).get('http.request')!;
    const err = await guarded.run(ctx({ method: 'GET', url: `${baseUrl}/ok` })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('ssrf_blocked');
  });

  test('invalid parameters rejected', async () => {
    const err = await httpDef().run(ctx({ method: 'YOLO', url: 'x' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('invalid_parameters');
  });
});
