import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { providerCheck, providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    to: z.string().min(1),
    text: z.string().min(1).optional(),
    templateName: z.string().min(1).optional(),
    templateLangCode: z.string().min(1).default('en_US'),
  })
  .strict()
  .refine((p) => (p.text === undefined) !== (p.templateName === undefined), {
    message: 'provide exactly one of text or templateName',
  });

const DEFAULT_BASE = 'https://graph.facebook.com';
const API_VERSION = 'v20.0';

function connOf(payload: unknown): { accessToken: string; phoneNumberId: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.whatsapp.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid whatsapp connection payload', false);
  return parsed.data;
}

export const whatsappSendMessage: ConnectorDefinition = {
  type: 'whatsapp.sendMessage',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  display: {
    displayName: 'Send WhatsApp message',
    description: 'Send a WhatsApp message to a phone number — either free text, or a pre-approved template, but not both.',
    category: 'Messaging',
    glyph: '☏',
  },
  paramsSchema,
  requiresConnection: 'whatsapp',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const message =
      parsed.data.text !== undefined
        ? { type: 'text', text: { body: parsed.data.text } }
        : {
            type: 'template',
            template: { name: parsed.data.templateName, language: { code: parsed.data.templateLangCode } },
          };
    const data = (await providerFetch(
      `${base}/${API_VERSION}/${conn.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${conn.accessToken}` },
        body: { messaging_product: 'whatsapp', to: parsed.data.to, ...message },
      },
      ctx.signal,
    )) as { messages?: { id: string }[] };
    const messageId = data.messages?.[0]?.id;
    if (typeof messageId !== 'string') throw new NodeRunError('provider_error', 'whatsapp returned no message id', false);
    return { output: { messageId } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    await providerCheck(`${conn.baseUrl ?? DEFAULT_BASE}/${API_VERSION}/${conn.phoneNumberId}?fields=id`, signal, {
      authorization: `Bearer ${conn.accessToken}`,
    });
  },
};
