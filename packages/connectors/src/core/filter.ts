import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { applyOp, assertItems, FILTER_OPS, readField } from './compare.js';

const paramsSchema = z
  .object({
    items: z.unknown(),
    /** Empty means the element itself, so a list of scalars can be filtered directly. */
    field: z.string().max(200).default(''),
    op: z.enum(FILTER_OPS),
    value: z.unknown(),
    negate: z.boolean().default(false),
  })
  .strict();

export const coreFilter: ConnectorDefinition = {
  type: 'core.filter',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  // `empty` is what makes filter composable. Without it every author writes a core.if
  // on length(...) == 0 immediately downstream.
  outputPorts: ['main', 'empty'],
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    const { field, op, value, negate } = parsed.data;
    const items = assertItems('core.filter', parsed.data.items);

    if (op === 'in' && !Array.isArray(value)) {
      throw new NodeRunError('invalid_parameters', "core.filter op 'in' expects value to be an array", false);
    }

    const kept = items.filter((row) => {
      const matched = applyOp(op, readField('core.filter', row, field), value);
      return negate ? !matched : matched;
    });

    return {
      output: { items: kept, count: kept.length, inputCount: items.length },
      outputPort: kept.length === 0 ? 'empty' : 'main',
    };
  },
};
