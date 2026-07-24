import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDefaultRegistry, type NodeRunContext } from '../src/index.js';

let server: Server;
let base: string;
let lastReq: { path: string; auth: string | undefined; body: unknown } | null = null;
let failNext: number | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      lastReq = { path: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      res.setHeader('content-type', 'application/json');
      if (failNext) {
        res.statusCode = failNext;
        failNext = null;
        res.end('{"error":"provider says no"}');
        return;
      }
      if (req.url!.includes('/sendMessage')) res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
      else if (req.url!.includes('/chat/completions'))
        res.end(JSON.stringify({ choices: [{ message: { content: 'ai says hi' } }] }));
      else if (req.url!.includes(':generateContent'))
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini says hi' }] } }] }));
      else res.end(JSON.stringify({ ok: true, data: [] })); // getMe / models lists
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const registry = createDefaultRegistry();
const ctx = (parameters: unknown, connection: unknown): NodeRunContext => ({
  executionId: 'e',
  nodeId: 'n',
  attempt: 1,
  parameters,
  triggerBody: null,
  connection,
  signal: AbortSignal.timeout(5000),
  log: () => {},
});

describe('telegram.sendMessage', () => {
  const conn = () => ({ botToken: 'SECRET-BOT-TOKEN', baseUrl: base });
  test('sends and maps message id; token stays in path not headers', async () => {
    const r = await registry.get('telegram.sendMessage')!.run(ctx({ chatId: '99', text: 'halo' }, conn()));
    expect(r.output).toEqual({ messageId: 42 });
    expect(lastReq?.path).toContain('/botSECRET-BOT-TOKEN/sendMessage');
    expect(lastReq?.body).toEqual({ chat_id: '99', text: 'halo' });
  });
  test('provider 500 -> http_error with status, no secret in message', async () => {
    failNext = 500;
    const err = await registry
      .get('telegram.sendMessage')!
      .run(ctx({ chatId: '1', text: 'x' }, conn()))
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('http_error');
    expect((err as { details: { httpStatus: number } }).details.httpStatus).toBe(500);
    expect((err as Error).message).not.toContain('SECRET-BOT-TOKEN');
  });
  test('testConnection ok and failing', async () => {
    await expect(
      registry.get('telegram.sendMessage')!.testConnection!(conn(), AbortSignal.timeout(3000)),
    ).resolves.toBeUndefined();
    failNext = 401;
    await expect(
      registry.get('telegram.sendMessage')!.testConnection!(conn(), AbortSignal.timeout(3000)),
    ).rejects.toThrow();
  });
});

describe('openai.chat', () => {
  const conn = () => ({ apiKey: 'SECRET-OPENAI-KEY', baseUrl: base });
  test('sends bearer auth, maps text, defaults model', async () => {
    const r = await registry.get('openai.chat')!.run(ctx({ prompt: 'hi', system: 'be nice' }, conn()));
    expect(r.output).toEqual({ text: 'ai says hi' });
    expect(lastReq?.auth).toBe('Bearer SECRET-OPENAI-KEY');
    expect((lastReq?.body as { model: string }).model).toBe('gpt-4o-mini');
    expect((lastReq?.body as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual([
      'system',
      'user',
    ]);
  });
  test('429 -> http_error fact, no key in message', async () => {
    failNext = 429;
    const err = await registry
      .get('openai.chat')!
      .run(ctx({ prompt: 'x' }, conn()))
      .catch((e: unknown) => e);
    expect((err as { details: { httpStatus: number } }).details.httpStatus).toBe(429);
    expect((err as Error).message).not.toContain('SECRET-OPENAI-KEY');
  });
  test('testConnection ok', async () => {
    await expect(
      registry.get('openai.chat')!.testConnection!(conn(), AbortSignal.timeout(3000)),
    ).resolves.toBeUndefined();
  });
});

describe('gemini.generate', () => {
  const conn = () => ({ apiKey: 'SECRET-GEMINI-KEY', baseUrl: base });
  test('key in query, maps text, defaults model', async () => {
    const r = await registry.get('gemini.generate')!.run(ctx({ prompt: 'hi' }, conn()));
    expect(r.output).toEqual({ text: 'gemini says hi' });
    expect(lastReq?.path).toContain('models/gemini-1.5-flash:generateContent');
    expect(lastReq?.path).toContain('key=SECRET-GEMINI-KEY');
  });
  test('500 -> http_error, no key in message', async () => {
    failNext = 500;
    const err = await registry
      .get('gemini.generate')!
      .run(ctx({ prompt: 'x' }, conn()))
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('http_error');
    expect((err as Error).message).not.toContain('SECRET-GEMINI-KEY');
  });
  test('testConnection ok and failing', async () => {
    await expect(
      registry.get('gemini.generate')!.testConnection!(conn(), AbortSignal.timeout(3000)),
    ).resolves.toBeUndefined();
    failNext = 403;
    await expect(
      registry.get('gemini.generate')!.testConnection!(conn(), AbortSignal.timeout(3000)),
    ).rejects.toThrow();
  });
});
