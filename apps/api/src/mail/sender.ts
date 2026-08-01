import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only. HTML templating is out of scope. */
  text: string;
}

export interface MailSender {
  readonly name: 'log' | 'smtp' | 'memory';
  send(message: MailMessage): Promise<void>;
}

/** The subset of a nodemailer transport we use, so tests need no real transport. */
export interface MailTransportLike {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

/**
 * Records messages instead of sending them. Not a convenience: a raw token exists only
 * inside the email body, so without this there is no way for a test to drive the
 * verification or reset flow end to end.
 */
export function memoryMailSender(): { sender: MailSender; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    sender: {
      name: 'memory',
      async send(message) {
        sent.push(message);
      },
    },
  };
}

/**
 * Development transport. It writes password-reset links to the log, which is a production
 * hazard, so it says so once on construction.
 */
export function logMailSender(log: (msg: string, extra?: Record<string, unknown>) => void): MailSender {
  log('mail.log_transport_selected: messages are written to the log and NOT sent — not for production use');
  return {
    name: 'log',
    async send(message) {
      log(`mail.send to=${message.to} subject=${message.subject}\n${message.text}`);
    },
  };
}

export function smtpMailSender(cfg: { from: string; transport: MailTransportLike }): MailSender {
  return {
    name: 'smtp',
    async send(message) {
      await cfg.transport.sendMail({
        from: cfg.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

const DEFAULT_SMTP_PORT = 587;

/**
 * Startup-time transport selection. A misconfiguration throws here rather than on the first
 * password reset, so a deployment fails to boot instead of silently losing every recovery
 * email. Same shape as createKeyProviderFromEnv and resolvePaymentProvider.
 *
 * `transportFactory` is injectable so tests never open a socket.
 */
export function createMailSenderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  transportFactory?: (cfg: SmtpConfig) => MailTransportLike,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
): MailSender {
  const transport = env['MAIL_TRANSPORT'] ?? 'log';
  if (transport === 'log') return logMailSender(log);
  if (transport !== 'smtp') {
    throw new Error(`Unsupported MAIL_TRANSPORT '${transport}' — expected 'log' or 'smtp'`);
  }
  const host = env['SMTP_HOST'];
  if (!host) throw new Error('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
  const from = env['MAIL_FROM'];
  if (!from) throw new Error('MAIL_FROM is required when MAIL_TRANSPORT=smtp');
  const user = env['SMTP_USER'];
  const pass = env['SMTP_PASSWORD'];
  const cfg: SmtpConfig = {
    host,
    port: Number(env['SMTP_PORT'] ?? DEFAULT_SMTP_PORT),
    secure: env['SMTP_SECURE'] === 'true',
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
  const factory =
    transportFactory ?? ((c: SmtpConfig): MailTransportLike => nodemailer.createTransport(c) as MailTransportLike);
  return smtpMailSender({ from, transport: factory(cfg) });
}
