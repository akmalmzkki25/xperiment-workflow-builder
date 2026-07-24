import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClient, ApiError, type ClientDeps } from '../src/lib/api';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[];
let responder: (url: string, init: RequestInit) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function makeClient(overrides: Partial<ClientDeps> = {}): ApiClient {
  return new ApiClient({
    baseUrl: 'http://api.test',
    getToken: () => 'qs_token',
    getWorkspace: () => null,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return responder(String(url), init ?? {});
    }) as typeof fetch,
    ...overrides,
  });
}

beforeEach(() => {
  calls = [];
  responder = () => json(200, {});
});

describe('ApiClient.request', () => {
  test('attaches bearer and workspace headers; no content-type without body', async () => {
    const client = makeClient({ getWorkspace: () => 'ws-1' });
    await client.request('GET', '/v1/workflows');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer qs_token');
    expect(headers.get('x-xperiment-workspace')).toBe('ws-1');
    expect(headers.get('content-type')).toBeNull();
  });

  test('omits auth headers without token; sets content-type with body', async () => {
    const client = makeClient({ getToken: () => null });
    await client.request('POST', '/v1/things', { body: { a: 1 } });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }));
  });

  test('returns undefined on 204', async () => {
    responder = () => new Response(null, { status: 204 });
    const client = makeClient();
    await expect(client.request('DELETE', '/v1/x')).resolves.toBeUndefined();
  });

  test('throws ApiError with problem title and detail', async () => {
    responder = () => json(412, { title: 'Draft revision conflict', detail: 'modified elsewhere' });
    const client = makeClient();
    const err = await client.request('PUT', '/v1/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(412);
    expect((err as ApiError).title).toBe('Draft revision conflict');
    expect((err as ApiError).detail).toBe('modified elsewhere');
  });

  test('falls back to generic title on unparseable error body', async () => {
    responder = () => new Response('boom', { status: 500 });
    const client = makeClient();
    const err = await client.request('GET', '/v1/x').catch((e: unknown) => e);
    expect((err as ApiError).title).toBe('HTTP 500');
  });

  test('fires onUnauthorized on 401 and still throws', async () => {
    responder = () => json(401, { title: 'Unauthorized' });
    const onUnauthorized = vi.fn();
    const client = makeClient({ onUnauthorized });
    await expect(client.request('GET', '/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('endpoint helpers', () => {
  test('putDraft sends If-Match revision header', async () => {
    responder = () => json(200, { revision: 3 });
    const client = makeClient();
    const r = await client.putDraft('wf1', { nodes: [] }, 2);
    expect(r.revision).toBe(3);
    expect(calls[0]!.url).toBe('http://api.test/v1/workflows/wf1/draft');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(new Headers(calls[0]!.init.headers).get('if-match')).toBe('2');
  });

  test('listExecutions builds query string only from provided filters', async () => {
    responder = () => json(200, { items: [], nextCursor: null });
    const client = makeClient();
    await client.listExecutions({ workflowId: 'w-1', limit: 5 });
    await client.listExecutions();
    expect(calls[0]!.url).toBe('http://api.test/v1/executions?workflowId=w-1&limit=5');
    expect(calls[1]!.url).toBe('http://api.test/v1/executions');
  });

  test('method matrix hits the expected endpoints', async () => {
    responder = () =>
      json(200, { items: [], token: 't', triggers: [], ok: true, revision: 1, findings: [], valid: true });
    const client = makeClient();
    await client.register('a@b.co', 'password-123');
    await client.login('a@b.co', 'password-123');
    await client.me();
    await client.logout();
    await client.listConnectors();
    await client.listWorkflows();
    await client.createWorkflow('Lead check');
    await client.getWorkflow('wf1');
    await client.validate('wf1');
    await client.publish('wf1');
    await client.activate('wf1');
    await client.deactivate('wf1');
    await client.listTriggers('wf1');
    await client.execute('wf1');
    await client.listConnections();
    await client.createConnection('telegram', 'Bot', { botToken: 'x' });
    await client.deleteConnection('c1');
    await client.testConnection('c1');
    await client.getExecution('e1');
    await client.aiGenerate('make a flow');
    await client.aiEdit('tweak it', { nodes: [] });
    await client.cancelExecution('e1');
    await client.retryExecution('e1');
    await client.getUsage();
    await client.getDiff('wf1', 'draft', 'v1');
    await client.rollbackVersion('wf1', 'v1');
    await client.listAlerts();
    await client.createAlert({ name: 'r', type: 'failure_rate', params: {} });
    await client.listAlertEvents();
    await client.acknowledgeAlert('a1');
    const seen = calls.map((c) => `${c.init.method} ${c.url.replace('http://api.test', '')}`);
    expect(seen).toEqual([
      'POST /v1/auth/register',
      'POST /v1/auth/login',
      'GET /v1/auth/me',
      'POST /v1/auth/logout',
      'GET /v1/connectors',
      'GET /v1/workflows',
      'POST /v1/workflows',
      'GET /v1/workflows/wf1',
      'POST /v1/workflows/wf1/validate',
      'POST /v1/workflows/wf1/publish',
      'POST /v1/workflows/wf1/activate',
      'POST /v1/workflows/wf1/deactivate',
      'GET /v1/workflows/wf1/triggers',
      'POST /v1/workflows/wf1/execute',
      'GET /v1/connections',
      'POST /v1/connections',
      'DELETE /v1/connections/c1',
      'POST /v1/connections/c1/test',
      'GET /v1/executions/e1',
      'POST /v1/ai/generate',
      'POST /v1/ai/edit',
      'POST /v1/executions/e1/cancel',
      'POST /v1/executions/e1/retry',
      'GET /v1/usage',
      'GET /v1/workflows/wf1/diff?from=draft&to=v1',
      'POST /v1/workflows/wf1/versions/v1/rollback',
      'GET /v1/alerts',
      'POST /v1/alerts',
      'GET /v1/alerts/events',
      'POST /v1/alerts/events/a1/ack',
    ]);
  });
});
