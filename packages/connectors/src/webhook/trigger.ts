import { z } from 'zod';
import type { ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    // The last three are provider schemes, not choices about strength: Meta signs under
    // its own header name, Xendit sends a bare token, and Midtrans puts a SHA-512 digest
    // inside the body. Each provider dictates exactly one.
    authMode: z.enum(['none', 'token', 'hmac', 'meta', 'xendit', 'midtrans']),
    idempotencyKeyPath: z.string().min(1).optional(),
  })
  .strict();

export const webhookTrigger: ConnectorDefinition = {
  type: 'webhook.trigger',
  kind: 'trigger',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  display: {
    displayName: 'On a webhook',
    description: 'Start the workflow when another app sends data to this workflow’s web address.',
    category: 'Triggers',
    glyph: '⚡',
  },
  paramsSchema,
  async run(ctx) {
    return { output: ctx.triggerBody ?? null };
  },
};
