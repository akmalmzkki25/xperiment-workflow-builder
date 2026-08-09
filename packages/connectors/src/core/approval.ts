import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const MAX_MS = 2_592_000_000; // 30 days
const paramsSchema = z
  .object({
    message: z.string().min(1).max(500),
    ttlMs: z.number().int().min(1).max(MAX_MS),
    fallback: z.enum(['approve', 'reject', 'fail']),
  })
  .strict();

export const coreApproval: ConnectorDefinition = {
  type: 'core.approval',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['approved', 'rejected'],
  display: {
    displayName: 'Wait for approval',
    description: 'Pause the run until a person approves or rejects it.',
    category: 'Logic',
    glyph: '✋',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    return {
      suspend: {
        kind: 'approval',
        ttlMs: parsed.data.ttlMs,
        fallback: parsed.data.fallback,
        message: parsed.data.message,
      },
    };
  },
};
