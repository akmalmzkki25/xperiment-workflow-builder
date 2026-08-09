import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { providerCheck, providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().min(1).default('gpt-4o-mini'),
    system: z.string().optional(),
  })
  .strict();
const DEFAULT_BASE = 'https://api.openai.com';

function connOf(payload: unknown): { apiKey: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.openai.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid openai connection payload', false);
  return parsed.data;
}

export const openaiChat: ConnectorDefinition = {
  type: 'openai.chat',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  display: {
    displayName: 'Ask OpenAI',
    description: 'Generate text with an OpenAI chat model.',
    category: 'AI',
    glyph: '✧',
  },
  paramsSchema,
  requiresConnection: 'openai',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const messages = [
      ...(parsed.data.system ? [{ role: 'system', content: parsed.data.system }] : []),
      { role: 'user', content: parsed.data.prompt },
    ];
    const data = (await providerFetch(
      `${base}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${conn.apiKey}` },
        body: { model: parsed.data.model, messages },
      },
      ctx.signal,
    )) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new NodeRunError('provider_error', 'openai returned no text', false);
    return { output: { text } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    await providerCheck(`${conn.baseUrl ?? DEFAULT_BASE}/v1/models`, signal, {
      authorization: `Bearer ${conn.apiKey}`,
    });
  },
};
