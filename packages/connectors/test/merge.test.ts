import { describe, expect, test } from 'vitest';
import { coreMerge } from '../src/core/merge.js';
import { NodeRunError, type NodeRunContext } from '../src/index.js';

function ctx(parameters: unknown): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'mg',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: new AbortController().signal,
    log: () => {},
  };
}

const out = (r: { output?: unknown }) => r.output as Record<string, unknown>;

describe('core.merge append', () => {
  test('concatenates arrays and pushes scalars as one element', async () => {
    const r = await coreMerge.run(ctx({ mode: 'append', sources: [[1, 2], 'x', [3]] }));
    expect(out(r)).toMatchObject({ items: [1, 2, 'x', 3], count: 4, sourceCount: 3 });
  });

  test('drops a null source, which is what a skipped branch looks like', async () => {
    // A branch that never ran is absent from ctx.nodes, so `nodes.a.output` evaluates to
    // null. That null IS the signal, which is why dropNulls defaults to true.
    const r = await coreMerge.run(ctx({ mode: 'append', sources: [null, ['b']] }));
    expect(out(r)).toMatchObject({ items: ['b'], count: 1, sourceCount: 1 });
  });

  test('dropNulls false keeps the null as an element', async () => {
    const r = await coreMerge.run(ctx({ mode: 'append', sources: [null, ['b']], dropNulls: false }));
    expect(out(r)).toMatchObject({ items: [null, 'b'], count: 2, sourceCount: 2 });
  });

  test('every source null yields an empty list rather than an error', async () => {
    const r = await coreMerge.run(ctx({ mode: 'append', sources: [null, null] }));
    expect(out(r)).toMatchObject({ items: [], count: 0, sourceCount: 0 });
  });
});

describe('core.merge combineByKey', () => {
  const left = [
    { sku: 'A', name: 'Kopi' },
    { sku: 'B', name: 'Teh' },
  ];
  const right = [
    // `name` OVERLAPS deliberately. With disjoint fields the spread is commutative and
    // toEqual ignores key order, so the precedence this test claims to pin would pass
    // under either order — the assertion would prove nothing.
    { sku: 'B', name: 'Teh Botol', stock: 4 },
    { sku: 'C', stock: 9 },
  ];

  test('merges rows left to right with later sources winning', async () => {
    const r = await coreMerge.run(ctx({ mode: 'combineByKey', key: 'sku', sources: [left, right] }));
    expect(out(r)['items']).toEqual([
      { sku: 'A', name: 'Kopi' },
      { sku: 'B', name: 'Teh Botol', stock: 4 },
      { sku: 'C', stock: 9 },
    ]);
    const reversed = await coreMerge.run(ctx({ mode: 'combineByKey', key: 'sku', sources: [right, left] }));
    const b = (out(reversed)['items'] as { sku: string; name?: string }[]).find((i) => i.sku === 'B');
    expect(b?.name).toBe('Teh');
  });

  test('an id of 1 and an id of "1" stay two rows', async () => {
    // node-postgres returns int8 and numeric columns as STRINGS by default, so joining a
    // postgres.query result against an HTTP API's JSON is exactly this case. String(raw)
    // as a map key would merge two different orders into one and lose the type.
    const r = await coreMerge.run(
      ctx({ mode: 'combineByKey', key: 'id', sources: [[{ id: 1, name: 'Kopi' }], [{ id: '1', stock: 9 }]] }),
    );
    expect(out(r)).toMatchObject({ count: 2 });
  });

  test('refuses a row whose key is absent rather than folding them together', async () => {
    // Folding keyless rows into one bucket discards every one but the last, silently.
    const err = await coreMerge
      .run(ctx({ mode: 'combineByKey', key: 'sku', sources: [[{ a: 1 }, { a: 2 }], [{ b: 3 }]] }))
      .catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('missing_merge_key');
    expect((err as NodeRunError).retryable).toBe(false);
  });

  test('refuses a non-primitive key rather than merging everything into [object Object]', async () => {
    const err = await coreMerge
      .run(ctx({ mode: 'combineByKey', key: 'c', sources: [[{ c: { id: 7 } }], [{ c: { id: 8 } }]] }))
      .catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('unsupported_group_key');
  });

  test('never reads an inherited property as a key', async () => {
    // A bare cur[segment] returns Object.prototype.toString, so every row would share
    // one key and three rows would merge into one.
    const err = await coreMerge
      .run(ctx({ mode: 'combineByKey', key: 'toString', sources: [[{ a: 1 }, { b: 2 }], [{ c: 3 }]] }))
      .catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('missing_merge_key');
  });

  test('output is sorted by key, not by arrival order', async () => {
    // Arrival order is a race between worker processes over a Redis queue.
    const forward = await coreMerge.run(ctx({ mode: 'combineByKey', key: 'sku', sources: [left, right] }));
    const swapped = await coreMerge.run(ctx({ mode: 'combineByKey', key: 'sku', sources: [right, left] }));
    expect((out(forward)['items'] as { sku: string }[]).map((i) => i.sku)).toEqual(['A', 'B', 'C']);
    expect((out(swapped)['items'] as { sku: string }[]).map((i) => i.sku)).toEqual(['A', 'B', 'C']);
  });

  test('requires a key and rejects a non-array source or a non-object row', async () => {
    await expect(coreMerge.run(ctx({ mode: 'combineByKey', sources: [left, right] }))).rejects.toBeInstanceOf(
      NodeRunError,
    );
    const notArray = await coreMerge
      .run(ctx({ mode: 'combineByKey', key: 'sku', sources: [left, 'nope'] }))
      .catch((e: unknown) => e);
    expect((notArray as NodeRunError).code).toBe('source_not_array');
    const notObject = await coreMerge
      .run(ctx({ mode: 'combineByKey', key: 'sku', sources: [left, [1, 2]] }))
      .catch((e: unknown) => e);
    expect((notObject as NodeRunError).code).toBe('row_not_object');
  });

  test('reports how many rows went in, so a collapse is visible', async () => {
    const r = await coreMerge.run(ctx({ mode: 'combineByKey', key: 'sku', sources: [left, right] }));
    expect(out(r)).toMatchObject({ inputCount: 4, count: 3 });
  });
});

describe('core.merge priority', () => {
  test('returns the first non-null source and its index', async () => {
    const r = await coreMerge.run(ctx({ mode: 'priority', sources: [null, 'fallback', 'later'] }));
    expect(out(r)).toMatchObject({ value: 'fallback', sourceIndex: 1 });
  });

  test('every source null yields a null value and no index', async () => {
    const r = await coreMerge.run(ctx({ mode: 'priority', sources: [null, null] }));
    expect(out(r)).toMatchObject({ value: null, sourceIndex: null });
  });

  test('a falsy but present value still wins', async () => {
    const r = await coreMerge.run(ctx({ mode: 'priority', sources: [0, 'later'] }));
    expect(out(r)).toMatchObject({ value: 0, sourceIndex: 0 });
  });
});

describe('core.merge guards', () => {
  test('rejects fewer than two or more than ten sources', async () => {
    await expect(coreMerge.run(ctx({ mode: 'append', sources: [[1]] }))).rejects.toBeInstanceOf(NodeRunError);
    const eleven = Array.from({ length: 11 }, () => []);
    await expect(coreMerge.run(ctx({ mode: 'append', sources: eleven }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('rejects a key on a mode that does not use one', async () => {
    await expect(coreMerge.run(ctx({ mode: 'append', key: 'sku', sources: [[], []] }))).rejects.toBeInstanceOf(
      NodeRunError,
    );
  });
});
