import { describe, expect, test } from 'vitest';
import { compareValues, readField, MAX_ITEMS } from '../src/core/compare.js';
import { coreFilter } from '../src/core/filter.js';
import { coreLimit } from '../src/core/limit.js';
import { coreSort } from '../src/core/sort.js';
import { NodeRunError, type NodeRunContext } from '../src/index.js';

function ctx(parameters: unknown): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'op',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: new AbortController().signal,
    log: () => {},
  };
}

const rows = [
  { sku: 'A', price: 1500, tags: ['x'], customer: { city: 'Bandung' } },
  { sku: 'B', price: 9900, tags: [], customer: { city: 'Jakarta' } },
  { sku: 'C', price: null, tags: ['y', 'z'], customer: {} },
  { sku: 'D', price: 250, customer: { city: 'Bandung' } },
];

describe('readField', () => {
  test('reads a dotted path and an array index', () => {
    expect(readField('readField', rows[0], 'customer.city')).toBe('Bandung');
    expect(readField('readField', rows[2], 'tags.1')).toBe('z');
  });

  test('an empty field means the element itself', () => {
    expect(readField('readField', 42, '')).toBe(42);
    expect(readField('readField', 'x', '')).toBe('x');
  });

  test('a missing path is undefined rather than a throw', () => {
    // C's customer object has no city; D has no tags key at all.
    expect(readField('readField', rows[2], 'customer.city')).toBeUndefined();
    expect(readField('readField', rows[3], 'tags')).toBeUndefined();
    expect(readField('readField', rows[3], 'customer.city.deeper')).toBeUndefined();
  });

  test('rejects a forbidden path segment', () => {
    expect(() => readField('readField', rows[0], '__proto__')).toThrow(NodeRunError);
    expect(() => readField('readField', rows[0], 'customer.constructor')).toThrow(NodeRunError);
  });
});

describe('compareValues', () => {
  test('nulls sort last in both directions', () => {
    // "Sort by price, highest first" must not put the rows with no price on top.
    const asc = [3, null, 1, undefined].sort(compareValues);
    expect(asc).toEqual([1, 3, null, undefined]);
  });

  test('strings compare by code unit, not locale', () => {
    // localeCompare ordering shifts with the ICU version, which would put the
    // determinism exit criterion at risk.
    expect(compareValues('Z', 'a')).toBeLessThan(0);
    expect([...'ba'].sort(compareValues)).toEqual(['a', 'b']);
  });

  test('mixed types fall back to a stable type rank rather than throwing', () => {
    expect([true, 'x', 1].sort(compareValues)).toEqual([1, 'x', true]);
  });
});

describe('core.filter', () => {
  test('keeps rows matching a strict equality', async () => {
    const r = await coreFilter.run(ctx({ items: rows, field: 'customer.city', op: 'eq', value: 'Bandung' }));
    expect((r.output as { items: unknown[] }).items).toHaveLength(2);
    expect(r.output).toMatchObject({ count: 2, inputCount: 4 });
    expect(r.outputPort).toBe('main');
  });

  test('a relational op excludes rows whose field is not comparable instead of failing', async () => {
    // Filtering 5000 rows where one has a null price must drop that row, not kill the run.
    // Removing rows that do not qualify is the job.
    const r = await coreFilter.run(ctx({ items: rows, field: 'price', op: 'gt', value: 1000 }));
    expect((r.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['A', 'B']);
  });

  test('contains, startsWith and endsWith are string-only on both sides', async () => {
    const hit = await coreFilter.run(ctx({ items: rows, field: 'sku', op: 'startsWith', value: 'A' }));
    expect((hit.output as { count: number }).count).toBe(1);
    const numeric = await coreFilter.run(ctx({ items: rows, field: 'price', op: 'contains', value: '15' }));
    expect((numeric.output as { count: number }).count).toBe(0);
  });

  test('in requires an array value', async () => {
    const r = await coreFilter.run(ctx({ items: rows, field: 'sku', op: 'in', value: ['A', 'D'] }));
    expect((r.output as { count: number }).count).toBe(2);
    await expect(coreFilter.run(ctx({ items: rows, field: 'sku', op: 'in', value: 'A' }))).rejects.toBeInstanceOf(
      NodeRunError,
    );
  });

  test('isNull and isEmpty distinguish absence from emptiness', async () => {
    // Only C has an explicit null price. D has a real one.
    const nulls = await coreFilter.run(ctx({ items: rows, field: 'price', op: 'isNull' }));
    expect((nulls.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['C']);
    // B has [], D has no tags key at all — an absent container counts as empty too.
    const emptyTags = await coreFilter.run(ctx({ items: rows, field: 'tags', op: 'isEmpty' }));
    expect((emptyTags.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['B', 'D']);
    // isNotNull is not the complement of isEmpty: B's price is present but its tags are not.
    const present = await coreFilter.run(ctx({ items: rows, field: 'price', op: 'isNotNull' }));
    expect((present.output as { count: number }).count).toBe(3);
  });

  test('negate inverts the predicate', async () => {
    const r = await coreFilter.run(
      ctx({ items: rows, field: 'customer.city', op: 'eq', value: 'Bandung', negate: true }),
    );
    expect((r.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['B', 'C']);
  });

  test('no surviving rows routes to the empty port', async () => {
    // Without this port every author writes a core.if on length(...) == 0.
    const r = await coreFilter.run(ctx({ items: rows, field: 'sku', op: 'eq', value: 'ZZZ' }));
    expect(r.outputPort).toBe('empty');
    expect(r.output).toMatchObject({ count: 0, inputCount: 4 });
  });

  test('a non-array items parameter is a non-retryable NodeRunError', async () => {
    const err = await coreFilter.run(ctx({ items: 'nope', field: '', op: 'eq', value: 1 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('items_not_array');
    expect((err as NodeRunError).retryable).toBe(false);
  });

  test('above the item cap it fails rather than truncating', async () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ n: i }));
    const err = await coreFilter.run(ctx({ items: many, field: 'n', op: 'gt', value: 0 })).catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('too_many_items');
    // Retrying cannot shorten the list.
    expect((err as NodeRunError).retryable).toBe(false);
  });
});

describe('core.sort', () => {
  test('sorts ascending and descending by a field', async () => {
    const asc = await coreSort.run(ctx({ items: rows, field: 'price' }));
    expect((asc.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['D', 'A', 'B', 'C']);
    const desc = await coreSort.run(ctx({ items: rows, field: 'price', direction: 'desc' }));
    // Nulls stay last in desc too — that is what "highest first" means to a human.
    expect((desc.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['B', 'A', 'D', 'C']);
  });

  test('sorts scalars when no field is given', async () => {
    const r = await coreSort.run(ctx({ items: [3, 1, 2] }));
    expect((r.output as { items: number[] }).items).toEqual([1, 2, 3]);
  });

  test('returns a NEW array and leaves the input untouched', async () => {
    // resolvedParams is written to input_json; mutating it corrupts the recorded trace.
    const input = [3, 1, 2];
    const r = await coreSort.run(ctx({ items: input }));
    expect(input).toEqual([3, 1, 2]);
    expect((r.output as { items: number[] }).items).not.toBe(input);
  });

  test('is stable for equal keys', async () => {
    const dupes = [
      { k: 1, id: 'first' },
      { k: 0, id: 'x' },
      { k: 1, id: 'second' },
    ];
    const r = await coreSort.run(ctx({ items: dupes, field: 'k' }));
    expect((r.output as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(['x', 'first', 'second']);
  });
});

describe('core.limit', () => {
  test('takes the first n and reports truncation', async () => {
    const r = await coreLimit.run(ctx({ items: rows, count: 2 }));
    expect((r.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['A', 'B']);
    expect(r.output).toMatchObject({ count: 2, inputCount: 4, truncated: true });
  });

  test('offset skips before taking', async () => {
    const r = await coreLimit.run(ctx({ items: rows, count: 2, offset: 2 }));
    expect((r.output as { items: { sku: string }[] }).items.map((i) => i.sku)).toEqual(['C', 'D']);
    expect(r.output).toMatchObject({ truncated: false });
  });

  test('a count at or above the length is not truncated', async () => {
    const r = await coreLimit.run(ctx({ items: rows, count: 10 }));
    expect(r.output).toMatchObject({ count: 4, truncated: false });
  });

  test('an offset past the end yields an empty list rather than an error', async () => {
    const r = await coreLimit.run(ctx({ items: rows, count: 5, offset: 99 }));
    expect(r.output).toMatchObject({ count: 0, truncated: false });
  });
});
