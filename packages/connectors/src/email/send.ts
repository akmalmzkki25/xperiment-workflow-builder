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

export function createEmailSend(deps: EmailDeps = {}): ConnectorDefinition {
  const factory = deps.transportFactory ?? ((opts) => nodemailer.createTransport(opts as never) as unknown as MailTransport);
  return {
    type: 'email.send',
    kind: 'action',
    operationVersion: '0.1.0',
    defaultEffectClass: 'write',
    outputPorts: ['main'],
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
      } catch {
        // Never surface SMTP error text — it can echo credentials.
        throw new NodeRunError('provider_error', 'smtp send failed', true);
      } finally {
        transport.close?.();
      }
    },
    async testConnection(payload) {
      const conn = connOf(payload);
      const transport = factory(transportOptions(conn));
      try {
        await transport.verify();
      } finally {
        transport.close?.();
      }
    },
  };
}

export const emailSend = createEmailSend();
