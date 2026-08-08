import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { assertItems, compareValues, readField } from './compare.js';

const paramsSchema = z
  .object({
    items: z.unknown(),
    field: z.string().max(200).default(''),
    direction: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();

export const coreSort: ConnectorDefinition = {
  type: 'core.sort',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    const { field, direction } = parsed.data;
    const items = assertItems('core.sort', parsed.data.items);

    // Decorate with the original index so stability is explicit rather than a property
    // of whichever sort the engine happens to use. Also builds a NEW array: the input is
    // resolvedParams, which is written to input_json, so mutating it corrupts the trace.
    const decorated = items.map((row, index) => ({ row, index, key: readField('core.sort', row, field) }));
    decorated.sort((a, b) => {
      const primary = compareValues(a.key, b.key);
      if (primary !== 0) return direction === 'desc' ? -primary : primary;
      return a.index - b.index;
    });

    // Absent keys stay last in BOTH directions, so negating the comparison above would be
    // wrong for them — compareValues already pins them, and the tie-break keeps them stable.
    const sorted = direction === 'desc' ? reorderAbsentLast(decorated) : decorated;
    const out = sorted.map((d) => d.row);
    return { output: { items: out, count: out.length }, outputPort: 'main' };
  },
};

interface Decorated {
  row: unknown;
  index: number;
  key: unknown;
}

/**
 * Descending negates the comparison, which would drag absent keys to the front. Pull them
 * back out and append them, preserving their original order.
 */
function reorderAbsentLast(decorated: Decorated[]): Decorated[] {
  const absent: Decorated[] = [];
  const present: Decorated[] = [];
  for (const d of decorated) {
    if (d.key === null || d.key === undefined) absent.push(d);
    else present.push(d);
  }
  if (absent.length === 0) return decorated;
  absent.sort((a, b) => a.index - b.index);
  return [...present, ...absent];
}
