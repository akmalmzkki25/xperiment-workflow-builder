import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { providerCheck, providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z.object({ chatId: z.string().min(1), text: z.string().min(1) }).strict();
const DEFAULT_BASE = 'https://api.telegram.org';

function connOf(payload: unknown): { botToken: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.telegram.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid telegram connection payload', false);
  return parsed.data;
}

export const telegramSendMessage: ConnectorDefinition = {
  type: 'telegram.sendMessage',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  display: {
    displayName: 'Send Telegram message',
    description: 'Send a message to a Telegram chat from your bot.',
    category: 'Messaging',
    glyph: '✈',
  },
  paramsSchema,
  requiresConnection: 'telegram',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const data = (await providerFetch(
      `${base}/bot${conn.botToken}/sendMessage`,
      { method: 'POST', body: { chat_id: parsed.data.chatId, text: parsed.data.text } },
      ctx.signal,
    )) as { ok: boolean; result?: { message_id: number } };
    if (!data.ok || !data.result) throw new NodeRunError('provider_error', 'telegram rejected the message', false);
    return { output: { messageId: data.result.message_id } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    await providerCheck(`${conn.baseUrl ?? DEFAULT_BASE}/bot${conn.botToken}/getMe`, signal);
  },
};
