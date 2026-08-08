import { describe, expect, test } from 'vitest';
import { coreAggregate, MAX_GROUPS } from '../src/core/aggregate.js';
import { MAX_ITEMS } from '../src/core/compare.js';
import { NodeRunError, type NodeRunContext } from '../src/index.js';

function ctx(parameters: unknown): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'agg',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: new AbortController().signal,
    log: () => {},
  };
}

const orders = [
  { city: 'Bandung', total: 1500, customer: { tier: 'gold' } },
  { city: 'Jakarta', total: 9900, customer: { tier: 'gold' } },
  { city: 'Bandung', total: 250, customer: { tier: 'silver' } },
  { city: 'Jakarta', total: 'not a number', customer: { tier: 'silver' } },
  { city: 'Bandung', customer: { tier: 'gold' } },
];

const out = (r: { output?: unknown }) => r.output as Record<string, unknown>;

describe('core.aggregate without grouping', () => {
  test('counts rows without needing a field', async () => {
    const r = await coreAggregate.run(ctx({ items: orders, operation: 'count' }));
    expect(out(r)).toMatchObject({ operation: 'count', value: 5, count: 5, skipped: 0 });
  });

  test('sums, averages, mins and maxes a numeric field', async () => {
    const sum = await coreAggregate.run(ctx({ items: orders, operation: 'sum', field: 'total' }));
    expect(out(sum)).toMatchObject({ value: 11650 });
    const min = await coreAggregate.run(ctx({ items: orders, operation: 'min', field: 'total' }));
    expect(out(min)).toMatchObject({ value: 250 });
    const max = await coreAggregate.run(ctx({ items: orders, operation: 'max', field: 'total' }));
    expect(out(max)).toMatchObject({ value: 9900 });
  });

  test('skips non-numeric rows and reports how many', async () => {
    // A silently wrong total is the failure this field exists to prevent: two of the five
    // rows have no usable number, and the caller has to be able to see that.
    const r = await coreAggregate.run(ctx({ items: orders, operation: 'avg', field: 'total' }));
    expect(out(r)).toMatchObject({ count: 3, skipped: 2 });
    expect(out(r)['value']).toBeCloseTo(3883.3333, 3);
  });

  test('sum of nothing is zero but avg, min and max of nothing are null', async () => {
    // Zero IS the identity for addition. It is not an honest mean, and a zero average
    // ends up on an invoice.
    const empty = { items: [], field: 'total' };
    expect(out(await coreAggregate.run(ctx({ ...empty, operation: 'sum' })))).toMatchObject({ value: 0, count: 0 });
    for (const operation of ['avg', 'min', 'max'] as const) {
      expect(out(await coreAggregate.run(ctx({ ...empty, operation }))), operation).toMatchObject({ value: null });
    }
    expect(out(await coreAggregate.run(ctx({ ...empty, operation: 'count' })))).toMatchObject({ value: 0 });
  });

  test('a field of only non-numeric values behaves like an empty list', async () => {
    const rows = [{ total: 'x' }, { total: null }];
    expect(out(await coreAggregate.run(ctx({ items: rows, operation: 'avg', field: 'total' })))).toMatchObject({
      value: null,
      count: 0,
      skipped: 2,
    });
  });

  test('requires a field for every operation except count', async () => {
    await expect(coreAggregate.run(ctx({ items: orders, operation: 'sum' }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreAggregate.run(ctx({ items: orders, operation: 'count' }))).resolves.toBeDefined();
  });
});

describe('core.aggregate with grouping', () => {
  test('groups into a sorted array of key and value', async () => {
    // An array, not a keyed object: an object would collide 1 with '1' and lose ordering,
    // and an array of {key,value} feeds core.loop directly.
    const r = await coreAggregate.run(ctx({ items: orders, operation: 'sum', field: 'total', groupBy: 'city' }));
    expect(out(r)).toMatchObject({ groupCount: 2 });
    expect(out(r)['groups']).toEqual([
      { key: 'Bandung', value: 1750, count: 2, skipped: 1 },
      { key: 'Jakarta', value: 9900, count: 1, skipped: 1 },
    ]);
  });

  test('group order does not depend on row order', async () => {
    // The city column in `orders` is palindromic, so reversing it does not change which
    // key is seen first — that fixture would pass even with insertion ordering. This one
    // puts Surabaya first going forward and Bandung first going back.
    const rows = [{ city: 'Surabaya' }, { city: 'Bandung' }, { city: 'Bandung' }];
    const forward = await coreAggregate.run(ctx({ items: rows, operation: 'count', groupBy: 'city' }));
    const reversed = await coreAggregate.run(ctx({ items: [...rows].reverse(), operation: 'count', groupBy: 'city' }));
    expect(out(forward)['groups']).toEqual([
      { key: 'Bandung', value: 2, count: 2, skipped: 0 },
      { key: 'Surabaya', value: 1, count: 1, skipped: 0 },
    ]);
    expect(out(reversed)['groups']).toEqual(out(forward)['groups']);
  });

  test('groups by a nested field', async () => {
    const r = await coreAggregate.run(ctx({ items: orders, operation: 'count', groupBy: 'customer.tier' }));
    expect(out(r)['groups']).toEqual([
      { key: 'gold', value: 3, count: 3, skipped: 0 },
      { key: 'silver', value: 2, count: 2, skipped: 0 },
    ]);
  });

  test('a null or absent group key becomes the literal string null', async () => {
    const rows = [{ city: null, n: 1 }, { n: 2 }, { city: 'Bogor', n: 3 }];
    const r = await coreAggregate.run(ctx({ items: rows, operation: 'sum', field: 'n', groupBy: 'city' }));
    expect(out(r)['groups']).toEqual([
      { key: 'Bogor', value: 3, count: 1, skipped: 0 },
      { key: 'null', value: 3, count: 2, skipped: 0 },
    ]);
  });

  test('refuses more than the group cap', async () => {
    // A groupBy on a unique id would otherwise build a payload that then trips the
    // 256 KiB node cap with a much more confusing error.
    const many = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ id: `k${i}` }));
    const err = await coreAggregate
      .run(ctx({ items: many, operation: 'count', groupBy: 'id' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('too_many_groups');
    expect((err as NodeRunError).retryable).toBe(false);
  });
});

describe('core.aggregate guards', () => {
  test('a non-array items parameter is a non-retryable NodeRunError', async () => {
    const err = await coreAggregate.run(ctx({ items: 'nope', operation: 'count' })).catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('items_not_array');
    expect((err as NodeRunError).retryable).toBe(false);
  });

  test('above the item cap it fails rather than truncating', async () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, () => ({ n: 1 }));
    const err = await coreAggregate.run(ctx({ items: many, operation: 'count' })).catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('too_many_items');
  });

  test('a sum that overflows fails rather than returning Infinity', async () => {
    // JSON.stringify(Infinity) is null, so a non-finite total would corrupt the payload.
    const huge = [{ n: 1e308 }, { n: 1e308 }];
    await expect(coreAggregate.run(ctx({ items: huge, operation: 'sum', field: 'n' }))).rejects.toBeInstanceOf(
      NodeRunError,
    );
  });

  test('rejects a forbidden field or groupBy path', async () => {
    await expect(
      coreAggregate.run(ctx({ items: orders, operation: 'count', groupBy: '__proto__' })),
    ).rejects.toBeInstanceOf(NodeRunError);
  });
});
