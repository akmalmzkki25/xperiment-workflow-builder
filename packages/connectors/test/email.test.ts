import { describe, expect, test, vi } from 'vitest';
import { createEmailSend, NodeRunError } from '../src/index.js';
import type { MailTransport, NodeRunContext } from '../src/index.js';

const conn = () => ({ host: 'smtp.test', port: 587, user: 'u', password: 'smtp-secret-pass', from: 'bot@xperiment.test' });

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

function fakeTransport(overrides: Partial<MailTransport> = {}): { transport: MailTransport; sent: unknown[]; opts: unknown } {
  const sent: unknown[] = [];
  const transport: MailTransport = {
    sendMail: async (msg) => {
      sent.push(msg);
      return { messageId: 'msg-1', accepted: ['a@b.co'] };
    },
    verify: async () => true as const,
    close: () => {},
    ...overrides,
  };
  return { transport, sent, opts: undefined };
}

describe('email.send', () => {
  test('sends with the connection from + params, returns the message id', async () => {
    const { transport, sent } = fakeTransport();
    let seenOpts: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } } | undefined;
    const connector = createEmailSend({
      transportFactory: (opts) => {
        seenOpts = opts as typeof seenOpts;
        return transport;
      },
    });
    const out = await connector.run(ctx({ to: 'a@b.co', subject: 'Hi', text: 'hello' }));
    expect(out.output).toEqual({ messageId: 'msg-1', accepted: ['a@b.co'] });
    expect(sent[0]).toMatchObject({ from: 'bot@xperiment.test', to: 'a@b.co', subject: 'Hi', text: 'hello' });
    expect(seenOpts?.auth).toEqual({ user: 'u', pass: 'smtp-secret-pass' });
    // Transport TLS/port derivation: port 587 → STARTTLS (secure:false); output carries no secret.
    expect(seenOpts?.port).toBe(587);
    expect(seenOpts?.secure).toBe(false);
    expect(JSON.stringify(out.output)).not.toContain('smtp-secret-pass');
  });

  test('secure defaults to true on the implicit-TLS port 465', async () => {
    let seenOpts: { secure: boolean } | undefined;
    const connector = createEmailSend({
      transportFactory: (opts) => {
        seenOpts = opts as typeof seenOpts;
        return fakeTransport().transport;
      },
    });
    const c465 = { ...ctx({ to: 'a@b.co', subject: 'x', text: 'y' }), connection: { ...conn(), port: 465 } };
    await connector.run(c465);
    expect(seenOpts?.secure).toBe(true);
  });

  test('requires text or html', async () => {
    const connector = createEmailSend({ transportFactory: () => fakeTransport().transport });
    await expect(connector.run(ctx({ to: 'a@b.co', subject: 'x' }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('a permanent auth failure is non-retryable and secret-free', async () => {
    const connector = createEmailSend({
      transportFactory: () =>
        fakeTransport({
          sendMail: async () => {
            throw Object.assign(new Error('535 auth failed for smtp-secret-pass'), {
              code: 'EAUTH',
              responseCode: 535,
            });
          },
        }).transport,
    });
    const err = await connector.run(ctx({ to: 'a@b.co', subject: 'x', text: 'y' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).retryable).toBe(false); // don't burn the retry budget on a doomed send
    expect((err as NodeRunError).message).not.toContain('smtp-secret-pass');
  });

  test('a transient connection failure is retryable', async () => {
    const connector = createEmailSend({
      transportFactory: () =>
        fakeTransport({
          sendMail: async () => {
            throw Object.assign(new Error('connection refused'), { code: 'ECONNECTION' });
          },
        }).transport,
    });
    const err = await connector.run(ctx({ to: 'a@b.co', subject: 'x', text: 'y' })).catch((e: unknown) => e);
    expect((err as NodeRunError).retryable).toBe(true);
  });

  test('invalid connection payload fails with connection_invalid', async () => {
    const connector = createEmailSend({ transportFactory: () => fakeTransport().transport });
    const badCtx = { ...ctx({ to: 'a@b.co', subject: 'x', text: 'y' }), connection: { host: 'only' } };
    await expect(connector.run(badCtx)).rejects.toMatchObject({ code: 'connection_invalid' });
  });

  test('testConnection verifies and closes the transport', async () => {
    const verify = vi.fn(async () => true as const);
    const close = vi.fn();
    const connector = createEmailSend({ transportFactory: () => fakeTransport({ verify, close }).transport });
    await connector.testConnection!(conn(), AbortSignal.timeout(3000));
    expect(verify).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
  });
});
