import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { providerCheck, providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().min(1).default('gemini-1.5-flash'),
  })
  .strict();
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

function connOf(payload: unknown): { apiKey: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.gemini.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid gemini connection payload', false);
  return parsed.data;
}

export const geminiGenerate: ConnectorDefinition = {
  type: 'gemini.generate',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  paramsSchema,
  requiresConnection: 'gemini',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const data = (await providerFetch(
      `${base}/v1beta/models/${parsed.data.model}:generateContent?key=${conn.apiKey}`,
      { method: 'POST', body: { contents: [{ parts: [{ text: parsed.data.prompt }] }] } },
      ctx.signal,
    )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new NodeRunError('provider_error', 'gemini returned no text', false);
    return { output: { text } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    await providerCheck(`${conn.baseUrl ?? DEFAULT_BASE}/v1beta/models?key=${conn.apiKey}`, signal);
  },
};
