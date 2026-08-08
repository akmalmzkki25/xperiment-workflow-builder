import { describe, expect, test } from 'vitest';
import { MAX_ITEMS } from '../src/core/compare.js';
import { coreLoop } from '../src/core/loop.js';
import { coreSplitBatch, MAX_BATCHES } from '../src/core/splitBatch.js';
import { NodeRunError, type NodeRunContext } from '../src/index.js';

function ctx(parameters: unknown): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'split',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: new AbortController().signal,
    log: () => {},
  };
}

const out = (r: { output?: unknown }) => r.output as Record<string, unknown>;

describe('core.splitBatch', () => {
  test('chunks evenly and leaves a short final batch', async () => {
    const r = await coreSplitBatch.run(ctx({ items: [1, 2, 3, 4, 5], size: 2 }));
    expect(out(r)['batches']).toEqual([[1, 2], [3, 4], [5]]);
    expect(out(r)).toMatchObject({ batchCount: 3, itemCount: 5, batchSize: 2 });
    expect(r.outputPort).toBe('main');
  });

  test('a size larger than the list yields one batch', async () => {
    const r = await coreSplitBatch.run(ctx({ items: [1, 2], size: 50 }));
    expect(out(r)['batches']).toEqual([[1, 2]]);
    expect(out(r)).toMatchObject({ batchCount: 1 });
  });

  test('an empty list routes to the empty port with no batches', async () => {
    const r = await coreSplitBatch.run(ctx({ items: [], size: 10 }));
    expect(out(r)).toMatchObject({ batches: [], batchCount: 0, itemCount: 0 });
    expect(r.outputPort).toBe('empty');
  });

  test('refuses a list above the item cap', async () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => i);
    const err = await coreSplitBatch.run(ctx({ items: many, size: 100 })).catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('too_many_items');
    expect((err as NodeRunError).retryable).toBe(false);
  });

  test('refuses a configuration that would produce more batches than the cap', async () => {
    const many = Array.from({ length: MAX_BATCHES + 1 }, (_, i) => i);
    const err = await coreSplitBatch.run(ctx({ items: many, size: 1 })).catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('too_many_batches');
    expect((err as NodeRunError).retryable).toBe(false);
  });

  test('a non-array items parameter is a non-retryable NodeRunError', async () => {
    const err = await coreSplitBatch.run(ctx({ items: 'nope', size: 2 })).catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('items_not_array');
  });

  test('rejects a size outside 1..1000', async () => {
    await expect(coreSplitBatch.run(ctx({ items: [1], size: 0 }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreSplitBatch.run(ctx({ items: [1], size: 1001 }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreSplitBatch.run(ctx({ items: [1], size: 1.5 }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('batches feed core.loop: each loop.item is one batch', async () => {
    // The composition test. A cursor node is impossible here (validateGraph rejects the
    // back-edge it would need), so this one edge IS the batching story.
    const split = await coreSplitBatch.run(ctx({ items: ['a', 'b', 'c'], size: 2 }));
    const batches = out(split)['batches'];
    const loop = await coreLoop.run(ctx({ items: batches }));
    expect((loop.output as { count: number }).count).toBe(2);
    expect(loop.outputPort).toBe('item');
    expect((loop.output as { items: unknown[] }).items[0]).toEqual(['a', 'b']);
  });

  test('an empty split still drives core.loop to done rather than stalling', async () => {
    const split = await coreSplitBatch.run(ctx({ items: [], size: 5 }));
    const loop = await coreLoop.run(ctx({ items: out(split)['batches'] }));
    expect(loop.outputPort).toBe('done');
  });
});
