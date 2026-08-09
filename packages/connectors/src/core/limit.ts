import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { assertItems, MAX_ITEMS } from './compare.js';

const paramsSchema = z
  .object({
    items: z.unknown(),
    count: z.number().int().min(1).max(MAX_ITEMS),
    offset: z.number().int().min(0).max(MAX_ITEMS).default(0),
  })
  .strict();

export const coreLimit: ConnectorDefinition = {
  type: 'core.limit',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  display: {
    displayName: 'Limit',
    description: 'Take the first or last few items of a list.',
    category: 'Data',
    glyph: '⇥',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    const { count, offset } = parsed.data;
    const items = assertItems('core.limit', parsed.data.items);
    const taken = items.slice(offset, offset + count);
    return {
      output: {
        items: taken,
        count: taken.length,
        inputCount: items.length,
        // The signal an author needs to decide whether to page again.
        truncated: offset + taken.length < items.length,
      },
      outputPort: 'main',
    };
  },
};
