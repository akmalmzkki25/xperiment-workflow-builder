import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { assertItems, assertOutputSize, compareValues, groupKeyOf, readField, type GroupKey } from './compare.js';

/** A groupBy on a unique id would build a payload that then trips the 256 KiB node cap. */
export const MAX_GROUPS = 1000;

const OPERATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
type Operation = (typeof OPERATIONS)[number];

const paramsSchema = z
  .object({
    items: z.unknown(),
    operation: z.enum(OPERATIONS),
    field: z.string().max(200).optional(),
    groupBy: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.operation !== 'count' && (v.field === undefined || v.field === '')) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: `operation '${v.operation}' needs a field`, path: ['field'] });
    }
    // count reads no field, so accepting one and throwing it away would answer
    // "count the orders that have an email" with the total row count instead.
    if (v.operation === 'count' && v.field !== undefined) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: "operation 'count' does not read a field", path: ['field'] });
    }
  });

interface Bucket {
  /** Values that are usable for the operation — finite numbers, or every row for count. */
  count: number;
  /** Rows whose field was absent or not a finite number. Visible on purpose. */
  skipped: number;
  sum: number;
  min: number | null;
  max: number | null;
}

function emptyBucket(): Bucket {
  return { count: 0, skipped: 0, sum: 0, min: null, max: null };
}

function accumulate(bucket: Bucket, operation: Operation, value: unknown): void {
  if (operation === 'count') {
    bucket.count += 1;
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bucket.skipped += 1;
    return;
  }
  bucket.count += 1;
  bucket.sum += value;
  bucket.min = bucket.min === null || value < bucket.min ? value : bucket.min;
  bucket.max = bucket.max === null || value > bucket.max ? value : bucket.max;
}

function resolve(bucket: Bucket, operation: Operation): number | null {
  switch (operation) {
    case 'count':
      return bucket.count;
    case 'sum':
      // Zero IS the identity for addition, so an empty list has an honest answer here.
      return finite(bucket.sum);
    case 'avg':
      // There is no honest mean of nothing, and a zero average lands on an invoice.
      return bucket.count === 0 ? null : finite(bucket.sum / bucket.count);
    case 'min':
      return bucket.min;
    default:
      return bucket.max;
  }
}

function finite(n: number): number {
  if (!Number.isFinite(n)) {
    // JSON.stringify(Infinity) is null, so a non-finite total would corrupt the payload.
    throw new NodeRunError('aggregate_overflow', 'core.aggregate produced a value that is not finite', false);
  }
  return n;
}

export const coreAggregate: ConnectorDefinition = {
  type: 'core.aggregate',
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
    const { operation, field, groupBy } = parsed.data;
    const items = assertItems('core.aggregate', parsed.data.items);
    const read = (row: unknown): unknown => (field === undefined ? undefined : readField('core.aggregate', row, field));

    if (groupBy === undefined) {
      const bucket = emptyBucket();
      for (const row of items) accumulate(bucket, operation, read(row));
      return {
        output: {
          operation,
          value: resolve(bucket, operation),
          // count is rows that CONTRIBUTED; inputCount removes any doubt about which
          // of the two a caller is reading. count + skipped === inputCount always.
          count: bucket.count,
          skipped: bucket.skipped,
          inputCount: items.length,
        },
        outputPort: 'main',
      };
    }

    const buckets = new Map<string, { key: GroupKey; bucket: Bucket }>();
    for (const row of items) {
      // Type-tagged, so the number 1 and the string '1' stay two customers.
      const key = groupKeyOf('core.aggregate groupBy', readField('core.aggregate', row, groupBy));
      let entry = buckets.get(key.id);
      if (entry === undefined) {
        if (buckets.size >= MAX_GROUPS) {
          throw new NodeRunError('too_many_groups', `core.aggregate refuses more than ${MAX_GROUPS} groups`, false);
        }
        entry = { key, bucket: emptyBucket() };
        buckets.set(key.id, entry);
      }
      accumulate(entry.bucket, operation, read(row));
    }

    // Sorted by the lossless id, never by insertion: insertion order would make the
    // output depend on the order the upstream connector happened to return its rows.
    const groups = [...buckets.values()]
      .sort((a, b) => compareValues(a.key.id, b.key.id))
      .map(({ key, bucket }) => ({
        key: key.display,
        keyType: key.type,
        value: resolve(bucket, operation),
        count: bucket.count,
        skipped: bucket.skipped,
      }));

    const output = { operation, groups, groupCount: groups.length, inputCount: items.length };
    assertOutputSize('core.aggregate', output);
    return { output, outputPort: 'main' };
  },
};
