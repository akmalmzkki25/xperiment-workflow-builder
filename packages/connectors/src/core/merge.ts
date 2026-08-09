import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { assertOutputSize, compareValues, groupKeyOf, readField, MAX_ITEMS } from './compare.js';

const MODES = ['append', 'combineByKey', 'priority'] as const;

const paramsSchema = z
  .object({
    mode: z.enum(MODES),
    /** Written by the author as ['{{ nodes.a.output }}', '{{ nodes.b.output }}']. */
    sources: z.array(z.unknown()).min(2).max(10),
    key: z.string().max(200).optional(),
    /** A skipped branch resolves to null, so dropping nulls is the default. */
    dropNulls: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === 'combineByKey' && (v.key === undefined || v.key === '')) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: 'combineByKey needs a key', path: ['key'] });
    }
    if (v.mode !== 'combineByKey' && v.key !== undefined) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: `key is only used by combineByKey`, path: ['key'] });
    }
  });

function assertCap(count: number): void {
  if (count > MAX_ITEMS) {
    throw new NodeRunError('too_many_items', `core.merge refuses more than ${MAX_ITEMS} items`, false);
  }
}

/**
 * Recombines branches.
 *
 * It needs NO scheduler change. computeReadiness already waits until every inbound edge
 * is *decided* and then fires if at least one is *active*, and a SKIPPED predecessor
 * resolves as decided-but-inactive — so a fan-in behind a core.if already works today.
 *
 * There is deliberately no "first arrival" mode: which branch wins would be a race
 * between worker processes over a Redis queue, i.e. nondeterministic by construction.
 * `priority` expresses the same authoring intent deterministically and costs nothing.
 */
export const coreMerge: ConnectorDefinition = {
  type: 'core.merge',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  display: {
    displayName: 'Merge branches',
    description: 'Combine the output of several branches into one.',
    category: 'Logic',
    glyph: '⋈',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    const { mode, sources, key, dropNulls } = parsed.data;
    const usable = dropNulls ? sources.filter((s) => s !== null && s !== undefined) : sources;

    if (mode === 'priority') {
      const index = sources.findIndex((s) => s !== null && s !== undefined);
      return {
        output: index === -1 ? { value: null, sourceIndex: null } : { value: sources[index], sourceIndex: index },
        outputPort: 'main',
      };
    }

    if (mode === 'append') {
      const items: unknown[] = [];
      for (const source of usable) {
        const incoming = Array.isArray(source) ? source : [source];
        // Check BEFORE appending, and append in a loop: `push(...source)` spreads the
        // whole array as call arguments and blows the stack around 131k elements — which
        // fits inside a legal 256 KiB upstream payload, and whose exact threshold is
        // stack-size dependent, so the same input could pass on one worker and not another.
        assertCap(items.length + incoming.length);
        for (const item of incoming) items.push(item);
      }
      const output = { items, count: items.length, sourceCount: usable.length };
      // The item cap is a count, not a size: ten sources of 1,000 rows each are all
      // individually legal and together are ten times what a node output may hold.
      assertOutputSize('core.merge', output);
      return { output, outputPort: 'main' };
    }

    const merged = new Map<string, Record<string, unknown>>();
    let rowsSeen = 0;
    for (const source of usable) {
      if (!Array.isArray(source)) {
        throw new NodeRunError('source_not_array', 'core.merge combineByKey expects every source to be an array', false);
      }
      for (const row of source) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          throw new NodeRunError('row_not_object', 'core.merge combineByKey expects every row to be an object', false);
        }
        rowsSeen += 1;
        // Bounds the work, not just the distinct-key count: rows that all share one key
        // would otherwise never trip a cap on `merged.size`.
        assertCap(rowsSeen);
        const raw = readField('core.merge', row, key!);
        if (raw === null || raw === undefined) {
          // A row with no key cannot be combined BY KEY. Folding them all into one bucket
          // silently discards every one but the last.
          throw new NodeRunError(
            'missing_merge_key',
            `core.merge combineByKey found a row with no '${key!}'`,
            false,
          );
        }
        // Type-tagged, so an id of 1 and an id of '1' stay two rows — which matters
        // because node-postgres returns int8 and numeric columns as strings.
        const id = groupKeyOf('core.merge key', raw).id;
        // Later sources win.
        merged.set(id, { ...(merged.get(id) ?? {}), ...(row as Record<string, unknown>) });
      }
    }

    // Sorted by the lossless key, never by arrival: arrival is a race between workers.
    const items = [...merged.entries()].sort((a, b) => compareValues(a[0], b[0])).map(([, row]) => row);
    const output = { items, count: items.length, sourceCount: usable.length, inputCount: rowsSeen };
    assertOutputSize('core.merge', output);
    return { output, outputPort: 'main' };
  },
};
