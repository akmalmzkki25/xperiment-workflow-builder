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
  });

  test('requires text or html', async () => {
    const connector = createEmailSend({ transportFactory: () => fakeTransport().transport });
    await expect(connector.run(ctx({ to: 'a@b.co', subject: 'x' }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('maps a send failure to a retryable provider_error without leaking the password', async () => {
    const connector = createEmailSend({
      transportFactory: () =>
        fakeTransport({
          sendMail: async () => {
            throw new Error('535 auth failed for smtp-secret-pass');
          },
        }).transport,
    });
    const err = await connector.run(ctx({ to: 'a@b.co', subject: 'x', text: 'y' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).retryable).toBe(true);
    expect((err as NodeRunError).message).not.toContain('smtp-secret-pass');
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
