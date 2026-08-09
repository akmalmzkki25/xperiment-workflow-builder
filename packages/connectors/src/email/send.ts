import nodemailer from 'nodemailer';
import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    to: z.string().min(1),
    subject: z.string().min(1),
    text: z.string().optional(),
    html: z.string().optional(),
  })
  .strict()
  .refine((p) => p.text !== undefined || p.html !== undefined, { message: 'provide text or html' });

export interface MailTransport {
  sendMail(msg: unknown): Promise<{ messageId: string; accepted: string[] }>;
  verify(): Promise<true>;
  close?(): void;
}

export interface EmailDeps {
  transportFactory?: (opts: unknown) => MailTransport;
}

function connOf(payload: unknown) {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.smtp.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid smtp connection payload', false);
  return parsed.data;
}

function transportOptions(conn: z.infer<(typeof CONNECTION_PAYLOAD_SCHEMAS)['smtp']>) {
  return {
    host: conn.host,
    port: conn.port,
    secure: conn.secure ?? conn.port === 465,
    auth: { user: conn.user, pass: conn.password },
  };
}

/**
 * Transient SMTP failures (connection/timeout, or a 4xx response) are worth
 * retrying; permanent ones (bad auth EAUTH/535, bad envelope 5xx) are not, so we
 * don't burn the retry budget on a doomed send. The error text is never surfaced
 * (it can echo credentials — CON-020).
 */
function isTransientSmtpError(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number };
  const transientCodes = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET'];
  if (e.code && transientCodes.includes(e.code)) return true;
  if (typeof e.responseCode === 'number') return e.responseCode >= 400 && e.responseCode < 500;
  return false;
}

export function createEmailSend(deps: EmailDeps = {}): ConnectorDefinition {
  const factory = deps.transportFactory ?? ((opts) => nodemailer.createTransport(opts as never) as unknown as MailTransport);
  return {
    type: 'email.send',
    kind: 'action',
    operationVersion: '0.1.0',
    defaultEffectClass: 'write',
    outputPorts: ['main'],
    display: {
      displayName: 'Send email',
      description: 'Send an email through your own SMTP server.',
      category: 'Messaging',
      glyph: '✉',
    },
    paramsSchema,
    requiresConnection: 'smtp',
    async run(ctx) {
      const parsed = paramsSchema.safeParse(ctx.parameters);
      if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
      const conn = connOf(ctx.connection);
      const transport = factory(transportOptions(conn));
      try {
        const result = await transport.sendMail({
          from: conn.from,
          to: parsed.data.to,
          subject: parsed.data.subject,
          ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
          ...(parsed.data.html !== undefined ? { html: parsed.data.html } : {}),
        });
        return { output: { messageId: result.messageId, accepted: result.accepted } };
      } catch (err) {
        // Never surface SMTP error text — it can echo credentials.
        throw new NodeRunError('provider_error', 'smtp send failed', isTransientSmtpError(err));
      } finally {
        transport.close?.();
      }
    },
    async testConnection(payload) {
      const conn = connOf(payload);
      const transport = factory(transportOptions(conn));
      try {
        await transport.verify();
      } catch {
        // Sanitize like run() — the raw verify() error can echo the password.
        throw new Error('smtp connection test failed');
      } finally {
        transport.close?.();
      }
    },
  };
}

export const emailSend = createEmailSend();
