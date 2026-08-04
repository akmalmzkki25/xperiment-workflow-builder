import { describe, expect, test } from 'vitest';
import { coreLoop } from '../src/core/loop.js';
import { NodeRunError, type NodeRunContext } from '../src/index.js';

function ctx(parameters: unknown): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'lp',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('core.loop', () => {
  test('reports the items and selects the item port', async () => {
    const r = await coreLoop.run(ctx({ items: ['a', 'b', 'c'] }));
    expect(r.output).toEqual({ items: ['a', 'b', 'c'], count: 3 });
    expect(r.outputPort).toBe('item');
  });

  test('an empty list goes straight to done', async () => {
    // With no iterations there is no join node, so the loop's own `done` edges are the ones
    // that must fire — see the design, §3.
    const r = await coreLoop.run(ctx({ items: [] }));
    expect(r.outputPort).toBe('done');
    expect(r.output).toEqual({ items: [], count: 0 });
  });

  test('declares both ports', () => {
    expect(coreLoop.outputPorts).toEqual(['item', 'done']);
  });

  test('refuses a non-array', async () => {
    await expect(coreLoop.run(ctx({ items: { a: 1 } }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreLoop.run(ctx({ items: null }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('refuses more items than maxIterations, naming both numbers', async () => {
    const err = (await coreLoop
      .run(ctx({ items: [1, 2, 3], maxIterations: 2 }))
      .catch((e: unknown) => e)) as NodeRunError;
    expect(err).toBeInstanceOf(NodeRunError);
    expect(err.code).toBe('too_many_iterations');
    expect(err.message).toContain('3');
    expect(err.message).toContain('2');
    // Retrying will not make the list shorter.
    expect(err.retryable).toBe(false);
  });

  test('defaults the cap to 100', async () => {
    const under = await coreLoop.run(ctx({ items: Array.from({ length: 100 }, (_, i) => i) }));
    expect(under.outputPort).toBe('item');
    const err = (await coreLoop
      .run(ctx({ items: Array.from({ length: 101 }, (_, i) => i) }))
      .catch((e: unknown) => e)) as NodeRunError;
    expect(err.code).toBe('too_many_iterations');
  });

  test('rejects a concurrency outside 1..10', async () => {
    await expect(coreLoop.run(ctx({ items: [1], concurrency: 0 }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreLoop.run(ctx({ items: [1], concurrency: 11 }))).rejects.toBeInstanceOf(NodeRunError);
    const ok = await coreLoop.run(ctx({ items: [1], concurrency: 10 }));
    expect(ok.outputPort).toBe('item');
  });

  test('rejects an unknown parameter', async () => {
    await expect(coreLoop.run(ctx({ items: [1], batchSize: 5 }))).rejects.toBeInstanceOf(NodeRunError);
  });
});
