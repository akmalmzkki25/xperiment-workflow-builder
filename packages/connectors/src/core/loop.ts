import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

export const DEFAULT_MAX_ITERATIONS = 100;
export const DEFAULT_CONCURRENCY = 1;

const paramsSchema = z
  .object({
    items: z.unknown(),
    maxIterations: z.number().int().min(1).max(1000).optional(),
    concurrency: z.number().int().min(1).max(10).optional(),
  })
  .strict();

/**
 * Fans a list out over the nodes scoped to this loop. The node itself runs nothing: it reports
 * the list, and the orchestrator rewrites the graph into one copy of the body per item.
 */
export const coreLoop: ConnectorDefinition = {
  type: 'core.loop',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['item', 'done'],
  display: {
    displayName: 'Loop over items',
    description: 'Run the nodes inside once for each item in a list, up to the iteration limit you set (100 by default).',
    category: 'Logic',
    glyph: '↻',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const items = parsed.data.items;
    if (!Array.isArray(items)) {
      throw new NodeRunError(
        'items_not_array',
        `core.loop items must resolve to an array, got ${items === null ? 'null' : typeof items}`,
        false,
      );
    }
    const max = parsed.data.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (items.length > max) {
      // Failing is louder than truncating, and unlike a silent drop it is routable down an
      // error port. Retrying will not make the list shorter, so this is not retryable.
      throw new NodeRunError(
        'too_many_iterations',
        `core.loop received ${items.length} items, above maxIterations ${max}`,
        false,
      );
    }
    // The items ride in this node's own output so each iteration's context can expose
    // loop.item without a second read. Like any node output this is subject to
    // PAYLOAD_CAP_BYTES; a list too large to store fails here, visibly and routably.
    return {
      output: { items, count: items.length },
      // No iterations means no join node, so the loop's own `done` edges must be the ones
      // that fire.
      outputPort: items.length === 0 ? 'done' : 'item',
    };
  },
};
