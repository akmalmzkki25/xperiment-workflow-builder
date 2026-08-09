import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const MAX_MS = 2_592_000_000; // 30 days
const paramsSchema = z.object({ timeoutMs: z.number().int().min(1).max(MAX_MS).optional() }).strict();

export const coreWaitForEvent: ConnectorDefinition = {
  type: 'core.waitForEvent',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  display: {
    displayName: 'Wait for a callback',
    description:
      'Pause the run until an outside system calls back with this node’s one-time resume link, or the timeout you set runs out.',
    category: 'Logic',
    glyph: '⏸',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    return { suspend: { kind: 'event', ...(parsed.data.timeoutMs ? { ttlMs: parsed.data.timeoutMs } : {}) } };
  },
};
