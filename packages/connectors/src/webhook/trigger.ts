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
  paramsSchema,
  async run(ctx) {
    return { output: ctx.triggerBody ?? null };
  },
};
