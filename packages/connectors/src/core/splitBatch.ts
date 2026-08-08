import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { assertItems } from './compare.js';

/** Keeps the emitted payload well inside the 256 KiB node cap. */
export const MAX_BATCHES = 1000;

const paramsSchema = z
  .object({
    items: z.unknown(),
    size: z.number().int().min(1).max(1000),
  })
  .strict();

/**
 * Emits the FULL list of batches on one port.
 *
 * Not a cursor that yields one batch per invocation: that needs per-execution mutable
 * state AND a back-edge from downstream to the splitter, and validateGraph rejects cycles
 * outright (`cycle_detected`) — so a cursor node is architecturally impossible in this IR.
 * Not "a port that fires N times" either: NodeRunResult carries a single outputPort and
 * the worker writes one completion, so firing a port repeatedly has no representation.
 *
 * Composes with core.loop in exactly one edge:
 *   splitBatch --main--> loop   with   items = {{ nodes.split.output.batches }}
 * so `{{ loop.item }}` is one batch. Reaching into it needs A1's numeric indexing.
 *
 * Interaction worth knowing: DEFAULT_MAX_ITERATIONS is 100, so 300 batches into a
 * default-configured core.loop fails with `too_many_iterations`. That is correct, but it
 * should be a documented interaction rather than a surprise.
 */
export const coreSplitBatch: ConnectorDefinition = {
  type: 'core.splitBatch',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  // `empty` mirrors core.loop firing `done` on an empty list, rather than silently
  // doing nothing and leaving the graph with no active port.
  outputPorts: ['main', 'empty'],
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    const { size } = parsed.data;
    const items = assertItems('core.splitBatch', parsed.data.items);

    const batchCount = Math.ceil(items.length / size);
    if (batchCount > MAX_BATCHES) {
      throw new NodeRunError(
        'too_many_batches',
        `core.splitBatch would produce ${batchCount} batches, more than the limit of ${MAX_BATCHES}`,
        false,
      );
    }

    const batches: unknown[][] = [];
    for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));

    return {
      output: { batches, batchCount: batches.length, itemCount: items.length, batchSize: size },
      outputPort: batches.length === 0 ? 'empty' : 'main',
    };
  },
};
