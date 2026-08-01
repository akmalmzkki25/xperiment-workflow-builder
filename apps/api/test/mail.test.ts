import { describe, expect, test, vi } from 'vitest';
import {
  createMailSenderFromEnv,
  logMailSender,
  memoryMailSender,
  smtpMailSender,
  type MailTransportLike,
} from '../src/mail/sender.js';
import { passwordResetMessage, verifyEmailMessage } from '../src/mail/messages.js';

describe('memoryMailSender', () => {
  test('records what it was asked to send', async () => {
    const { sender, sent } = memoryMailSender();
    await sender.send({ to: 'a@b.test', subject: 'Hi', text: 'body' });
    expect(sender.name).toBe('memory');
    expect(sent).toEqual([{ to: 'a@b.test', subject: 'Hi', text: 'body' }]);
  });
});

describe('logMailSender', () => {
  test('logs the message and warns once that it must not be used in production', async () => {
    const lines: string[] = [];
    const sender = logMailSender((msg) => lines.push(msg));
    await sender.send({ to: 'a@b.test', subject: 'Hi', text: 'body' });
    await sender.send({ to: 'c@d.test', subject: 'Yo', text: 'body2' });
    // One construction warning, then one line per message.
    expect(lines.filter((l) => /not for production/i.test(l))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('a@b.test'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('c@d.test'))).toHaveLength(1);
  });
});

describe('smtpMailSender', () => {
  test('hands the envelope to the transport with the configured from-address', async () => {
    const calls: Record<string, string>[] = [];
    const transport: MailTransportLike = {
      async sendMail(o) {
        calls.push(o as unknown as Record<string, string>);
        return {};
      },
    };
    const sender = smtpMailSender({ from: 'Xperiment <no-reply@xperiment.test>', transport });
    await sender.send({ to: 'a@b.test', subject: 'Hi', text: 'body' });
    expect(sender.name).toBe('smtp');
    expect(calls[0]).toEqual({
      from: 'Xperiment <no-reply@xperiment.test>',
      to: 'a@b.test',
      subject: 'Hi',
      text: 'body',
    });
  });

  test('a transport failure propagates rather than being swallowed', async () => {
    const transport: MailTransportLike = {
      async sendMail() {
        throw new Error('smtp down');
      },
    };
    const sender = smtpMailSender({ from: 'x@y.test', transport });
    await expect(sender.send({ to: 'a@b.test', subject: 'S', text: 'T' })).rejects.toThrow('smtp down');
  });
});

describe('createMailSenderFromEnv', () => {
  test('defaults to the log transport', () => {
    expect(createMailSenderFromEnv({}).name).toBe('log');
  });

  test('smtp builds from the injected factory and uses MAIL_FROM', () => {
    const factory = vi.fn(
      () =>
        ({
          async sendMail() {
            return {};
          },
        }) as MailTransportLike,
    );
    const sender = createMailSenderFromEnv(
      { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.test', SMTP_PORT: '587', MAIL_FROM: 'x@y.test' },
      factory,
    );
    expect(sender.name).toBe('smtp');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ host: 'mail.test', port: 587 }));
  });

  test('smtp without a host fails at startup, not at first send', () => {
    expect(() => createMailSenderFromEnv({ MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'x@y.test' })).toThrow(/SMTP_HOST/);
  });

  test('smtp without a from-address fails at startup', () => {
    expect(() => createMailSenderFromEnv({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.test' })).toThrow(/MAIL_FROM/);
  });

  test('an unknown transport is rejected rather than silently falling back to log', () => {
    expect(() => createMailSenderFromEnv({ MAIL_TRANSPORT: 'carrier-pigeon' })).toThrow(/MAIL_TRANSPORT/);
  });
});

describe('messages', () => {
  test('each carries a working link and never the bare token alone', () => {
    const verify = verifyEmailMessage('a@b.test', 'https://app.test', 'qv_abc');
    expect(verify.to).toBe('a@b.test');
    expect(verify.text).toContain('https://app.test/verify-email?token=qv_abc');

    const reset = passwordResetMessage('a@b.test', 'https://app.test', 'qr_xyz');
    expect(reset.text).toContain('https://app.test/reset-password?token=qr_xyz');
    // The reset mail must say how long it lives, or people sit on a dead link.
    expect(reset.text).toMatch(/1 hour/i);
  });
});
