import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { NodeRunError, slackPostMessage } from '../src/index.js';
import type { NodeRunContext } from '../src/index.js';

let server: Server;
let baseUrl: string;
let lastReq: { path: string; auth: string | undefined; body: unknown } | null = null;
let status = 200;
let responseBody: unknown = { ok: true, ts: '1786440000.000100', channel: 'C123' };

const BOT_TOKEN = 'xoxb-slack-secret-not-real';
const conn = () => ({ botToken: BOT_TOKEN, baseUrl });

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
      lastReq = { path: req.url ?? '', auth: req.headers['authorization'], body: raw.length ? JSON.parse(raw) : null };
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
  responseBody = { ok: true, ts: '1786440000.000100', channel: 'C123' };
  lastReq = null;
});

describe('slack.postMessage', () => {
  test('posts to the channel and returns the message timestamp', async () => {
    const out = await slackPostMessage.run(ctx({ channel: 'C123', text: 'Pesanan baru masuk' }));
    expect(out.output).toEqual({ ts: '1786440000.000100', channel: 'C123' });
    expect(lastReq?.path).toBe('/api/chat.postMessage');
    expect(lastReq?.auth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(lastReq?.body).toEqual({ channel: 'C123', text: 'Pesanan baru masuk' });
  });

  test('a thread timestamp is sent under Slack own field name', async () => {
    await slackPostMessage.run(ctx({ channel: 'C123', text: 'balasan', threadTs: '1786439000.000200' }));
    expect(lastReq?.body).toMatchObject({ thread_ts: '1786439000.000200' });
  });

  test('a 200 with ok:false is a provider error, not a success', async () => {
    // The trap this connector exists to avoid: providerFetch only throws on !res.ok, so
    // without an explicit check a revoked token would be recorded as a delivered message
    // and the workflow would carry on.
    responseBody = { ok: false, error: 'invalid_auth' };
    await expect(slackPostMessage.run(ctx({ channel: 'C123', text: 'hi' }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('ratelimited is retryable and invalid_auth is not', async () => {
    responseBody = { ok: false, error: 'ratelimited' };
    const rateLimited = await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => e);
    expect((rateLimited as NodeRunError).retryable).toBe(true);

    responseBody = { ok: false, error: 'invalid_auth' };
    const badToken = await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => e);
    expect((badToken as NodeRunError).retryable).toBe(false);
  });

  test('an ok:false error carries NO httpStatus, so the flag is actually honoured', async () => {
    // apps/worker/src/classify.ts OVERRIDES retryable for any NodeRunError carrying
    // details.httpStatus. Attaching one here would turn invalid_auth into three more
    // attempts against a token that will never work.
    responseBody = { ok: false, error: 'invalid_auth' };
    const err = (await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => e)) as NodeRunError;
    expect((err.details as { httpStatus?: number } | undefined)?.httpStatus).toBeUndefined();
  });

  test('an unrecognised slack error is not retried', async () => {
    // Retrying an error nobody has classified spends the attempt budget on a guess.
    responseBody = { ok: false, error: 'some_new_slack_error' };
    const err = (await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => e)) as NodeRunError;
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('slack_some_new_slack_error');
  });

  test('an ok:false with no error field still fails rather than passing', async () => {
    responseBody = { ok: false };
    const err = (await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => e)) as NodeRunError;
    expect(err.code).toBe('slack_unknown_error');
  });

  test('a 503 stays an http_error carrying the status, so retry policy decides', async () => {
    status = 503;
    responseBody = {};
    const err = (await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => e)) as NodeRunError;
    expect(err.code).toBe('http_error');
    expect((err.details as { httpStatus?: number }).httpStatus).toBe(503);
  });

  test('no failure message ever contains the bot token', async () => {
    const dumps: string[] = [];
    responseBody = { ok: false, error: 'invalid_auth' };
    dumps.push(JSON.stringify(await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => ({
      message: (e as Error).message,
      code: (e as NodeRunError).code,
      details: (e as NodeRunError).details,
    }))));
    status = 500;
    dumps.push(JSON.stringify(await slackPostMessage.run(ctx({ channel: 'C1', text: 'x' })).catch((e: unknown) => ({
      message: (e as Error).message,
    }))));
    dumps.push(
      JSON.stringify(
        await slackPostMessage.run({ ...ctx({ channel: 'C1', text: 'x' }), connection: { nope: true } }).catch(
          (e: unknown) => ({ message: (e as Error).message }),
        ),
      ),
    );
    for (const dump of dumps) expect(dump).not.toContain(BOT_TOKEN);
  });

  test('bad parameters fail before any request is made', async () => {
    await expect(slackPostMessage.run(ctx({ channel: '', text: 'x' }))).rejects.toBeInstanceOf(NodeRunError);
    expect(lastReq).toBeNull();
  });

  test('an invalid connection payload is refused without dialling out', async () => {
    await expect(
      slackPostMessage.run({ ...ctx({ channel: 'C1', text: 'x' }), connection: { botToken: '' } }),
    ).rejects.toBeInstanceOf(NodeRunError);
    expect(lastReq).toBeNull();
  });

  test('testConnection checks ok, not just the status code', async () => {
    // auth.test answers 200 with ok:false for a dead token, so a status-only probe would
    // call every broken connection healthy.
    responseBody = { ok: true };
    await expect(slackPostMessage.testConnection!(conn(), AbortSignal.timeout(3000))).resolves.toBeUndefined();
    responseBody = { ok: false, error: 'invalid_auth' };
    await expect(slackPostMessage.testConnection!(conn(), AbortSignal.timeout(3000))).rejects.toThrow();
  });
});
