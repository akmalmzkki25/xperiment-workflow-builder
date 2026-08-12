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
    await client.listDeliveries('wf1');
    await client.listDeliveries('wf1', 'hook');
    await client.listConnections();
    await client.createConnection('telegram', 'Bot', { botToken: 'x' });
    await client.rotateConnection('c1', { botToken: 'y' });
    await client.deleteConnection('c1');
    await client.testConnection('c1');
    await client.getExecution('e1');
    await client.aiGenerate('make a flow');
    await client.aiEdit('tweak it', { nodes: [] });
    await client.cancelExecution('e1');
    await client.retryExecution('e1');
    await client.getUsage();
    await client.listTemplates();
    await client.getTemplate('wa-lead-auto-reply');
    await client.cloneTemplate('wa-lead-auto-reply');
    await client.getDiff('wf1', 'draft', 'v1');
    await client.rollbackVersion('wf1', 'v1');
    await client.listAlerts();
    await client.createAlert({ name: 'r', type: 'failure_rate', params: {} });
    await client.listAlertEvents();
    await client.acknowledgeAlert('a1');
    await client.listMembers();
    await client.updateMemberRole('u1', 'operator');
    await client.getPlan();
    await client.updatePlan({ allowOverage: true });
    await client.listInvoices();
    await client.markInvoicePaid('i1');
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
      'GET /v1/workflows/wf1/deliveries',
      'GET /v1/workflows/wf1/deliveries?nodeId=hook',
      'GET /v1/connections',
      'POST /v1/connections',
      'PUT /v1/connections/c1',
      'DELETE /v1/connections/c1',
      'POST /v1/connections/c1/test',
      'GET /v1/executions/e1',
      'POST /v1/ai/generate',
      'POST /v1/ai/edit',
      'POST /v1/executions/e1/cancel',
      'POST /v1/executions/e1/retry',
      'GET /v1/usage',
      'GET /v1/templates',
      'GET /v1/templates/wa-lead-auto-reply',
      'POST /v1/templates/wa-lead-auto-reply/clone',
      'GET /v1/workflows/wf1/diff?from=draft&to=v1',
      'POST /v1/workflows/wf1/versions/v1/rollback',
      'GET /v1/alerts',
      'POST /v1/alerts',
      'GET /v1/alerts/events',
      'POST /v1/alerts/events/a1/ack',
      'GET /v1/workspaces/members',
      'PUT /v1/workspaces/members/u1',
      'GET /v1/plan',
      'PUT /v1/plan',
      'GET /v1/invoices',
      'POST /v1/invoices/i1/mark-paid',
    ]);
  });

  test('the recovery endpoints carry the right verbs, paths and bodies', async () => {
    responder = () => json(200, { sent: true, reset: true, verified: true });
    const client = makeClient();
    await client.forgotPassword('a@b.co');
    await client.resetPassword('qr_tok', 'new-password-1');
    await client.verifyEmail('qv_tok');
    await client.resendVerification();
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('http://api.test', '')}`)).toEqual([
      'POST /v1/auth/forgot-password',
      'POST /v1/auth/reset-password',
      'POST /v1/auth/verify-email',
      'POST /v1/auth/resend-verification',
    ]);
    expect(calls[0]!.init.body).toBe(JSON.stringify({ email: 'a@b.co' }));
    expect(calls[1]!.init.body).toBe(JSON.stringify({ token: 'qr_tok', password: 'new-password-1' }));
    expect(calls[2]!.init.body).toBe(JSON.stringify({ token: 'qv_tok' }));
    // Resend is identified by the session alone; a body would be a second, forgeable answer
    // to "whose address?".
    expect(calls[3]!.init.body).toBeUndefined();
  });

  test('the mfa endpoints carry the right verbs, paths and bodies', async () => {
    responder = () => json(200, { secretBase32: 'AAAA', otpauthUri: 'otpauth://x', recoveryCodes: [], token: 't' });
    const client = makeClient();
    await client.mfaSetup('pw');
    await client.mfaConfirm('123456', 'pw');
    await client.mfaDisable('123456');
    await client.mfaRecoveryCodes('123456');
    await client.mfaVerify('qm_c', '123456');
    await client.setMfaPolicy(true);
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('http://api.test', '')}`)).toEqual([
      'POST /v1/auth/mfa/setup',
      'POST /v1/auth/mfa/confirm',
      'POST /v1/auth/mfa/disable',
      'POST /v1/auth/mfa/recovery-codes',
      'POST /v1/auth/mfa/verify',
      'PUT /v1/workspaces/mfa-policy',
    ]);
    // Enrolment carries the password: a bearer token alone must not attach a factor.
    expect(calls[0]!.init.body).toBe(JSON.stringify({ password: 'pw' }));
    expect(calls[1]!.init.body).toBe(JSON.stringify({ code: '123456', password: 'pw' }));
    expect(calls[4]!.init.body).toBe(JSON.stringify({ challenge: 'qm_c', code: '123456' }));
    expect(calls[5]!.init.body).toBe(JSON.stringify({ requireMfa: true }));
  });

  test('template client builds the category query and the clone name body', async () => {
    responder = () => json(200, { items: [] });
    const client = makeClient();
    await client.listTemplates('sales');
    await client.cloneTemplate('t1', 'My name');
    expect(calls[0]!.url).toBe('http://api.test/v1/templates?category=sales');
    expect(calls[1]!.url).toBe('http://api.test/v1/templates/t1/clone');
    expect(calls[1]!.init.body).toBe(JSON.stringify({ name: 'My name' }));
  });
});
