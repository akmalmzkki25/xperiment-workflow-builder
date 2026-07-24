import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { NodeRunError, whatsappSendMessage } from '../src/index.js';
import type { NodeRunContext } from '../src/index.js';

let server: Server;
let baseUrl: string;
let lastReq: { path: string; auth: string | undefined; body: unknown } | null = null;
let status = 200;
let responseBody: unknown = { messages: [{ id: 'wamid.ABC' }] };

const conn = () => ({ accessToken: 'whatsapp-secret-token', phoneNumberId: '555001', baseUrl });

const ctx = (parameters: unknown): NodeRunContext => ({
  executionId: 'e',
  nodeId: 'n',
  attempt: 1,
  parameters,
  triggerBody: null,
  connection: conn(),
  signal: AbortSignal.timeout(3000),
  log: () => {},
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      lastReq = {
        path: req.url ?? '',
        auth: req.headers['authorization'],
        body: raw.length ? JSON.parse(raw) : null,
      };
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  status = 200;
  responseBody = { messages: [{ id: 'wamid.ABC' }] };
  lastReq = null;
});

describe('whatsapp.sendMessage', () => {
  test('sends a text message and returns the message id', async () => {
    const out = await whatsappSendMessage.run(ctx({ to: '628123', text: 'Halo' }));
    expect(out.output).toEqual({ messageId: 'wamid.ABC' });
    expect(lastReq?.path).toBe('/v20.0/555001/messages');
    expect(lastReq?.auth).toBe('Bearer whatsapp-secret-token');
    expect((lastReq?.body as { type: string }).type).toBe('text');
  });

  test('sends a template message', async () => {
    await whatsappSendMessage.run(ctx({ to: '628123', templateName: 'welcome', templateLangCode: 'id' }));
    const body = lastReq?.body as { type: string; template: { name: string; language: { code: string } } };
    expect(body.type).toBe('template');
    expect(body.template).toEqual({ name: 'welcome', language: { code: 'id' } });
  });

  test('requires exactly one of text or templateName', async () => {
    await expect(whatsappSendMessage.run(ctx({ to: '628123' }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(
      whatsappSendMessage.run(ctx({ to: '628123', text: 'a', templateName: 'b' })),
    ).rejects.toBeInstanceOf(NodeRunError);
  });

  test('maps a provider error and never leaks the token', async () => {
    status = 401;
    responseBody = { error: { message: 'bad token whatsapp-secret-token' } };
    const err = await whatsappSendMessage.run(ctx({ to: '628123', text: 'x' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).message).not.toContain('whatsapp-secret-token');
  });

  test('missing message id is a provider error', async () => {
    responseBody = { messages: [] };
    await expect(whatsappSendMessage.run(ctx({ to: '628123', text: 'x' }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('testConnection hits the phone-number endpoint', async () => {
    await expect(whatsappSendMessage.testConnection!(conn(), AbortSignal.timeout(3000))).resolves.toBeUndefined();
    expect(lastReq?.path).toBe('/v20.0/555001?fields=id');
    status = 403;
    await expect(whatsappSendMessage.testConnection!(conn(), AbortSignal.timeout(3000))).rejects.toBeInstanceOf(Error);
  });
});
