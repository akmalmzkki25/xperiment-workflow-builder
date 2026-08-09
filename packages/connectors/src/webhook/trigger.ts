import { z } from 'zod';
import type { ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    authMode: z.enum(['none', 'token', 'hmac']),
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
