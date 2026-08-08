import { describe, expect, test } from 'vitest';
import { buildContext } from '../src/index.js';

const NOW = Date.parse('2026-08-08T03:15:00.000Z');

describe('buildContext', () => {
  test('shapes the expression context', () => {
    const ctx = buildContext('exec-1', { name: 'Budi' }, { check: { exists: true } }, { now: NOW });
    expect(ctx).toEqual({
      trigger: { body: { name: 'Budi' } },
      nodes: { check: { output: { exists: true } } },
      execution: { id: 'exec-1' },
      now: NOW,
    });
  });

  test('carries the supplied evaluation instant onto the context', () => {
    // The only Date.now() in this path lives at the worker call site, so a test can
    // pin the clock and every date function in the node agrees with it.
    const ctx = buildContext('exec-3', null, {}, { now: 1234 });
    expect(ctx.now).toBe(1234);
  });

  test('handles null trigger body and empty outputs', () => {
    const ctx = buildContext('exec-2', null, {}, { now: NOW });
    expect(ctx.trigger.body).toBeNull();
    expect(ctx.nodes).toEqual({});
  });
});

describe('buildContext inside a loop iteration', () => {
  const outputs = {
    sheets: { rows: [1, 2, 3] },
    'b1#0': { v: 'zero' },
    'b1#1': { v: 'one' },
  };

  test('exposes the item and index of this iteration', () => {
    const ctx = buildContext('exec-1', null, outputs, { now: NOW, loop: { index: 1, item: { name: 'Budi' } } });
    expect(ctx.loop).toEqual({ index: 1, item: { name: 'Budi' } });
  });

  test('a sibling body node resolves to this iteration copy', () => {
    // The author writes `nodes.b1` and cannot know the instance id, so the alias is what
    // makes an expression inside a loop body work at all.
    const ctx = buildContext('exec-1', null, outputs, { now: NOW, loop: { index: 1, item: null } });
    expect(ctx.nodes['b1']?.output).toEqual({ v: 'one' });
    // The instance ids stay reachable too.
    expect(ctx.nodes['b1#0']?.output).toEqual({ v: 'zero' });
  });

  test('nodes outside the loop are untouched', () => {
    const ctx = buildContext('exec-1', null, outputs, { now: NOW, loop: { index: 0, item: null } });
    expect(ctx.nodes['sheets']?.output).toEqual({ rows: [1, 2, 3] });
  });

  test('without a loop frame there is no alias and no loop root', () => {
    const ctx = buildContext('exec-1', null, outputs, { now: NOW });
    expect(ctx.loop).toBeUndefined();
    expect(ctx.nodes['b1']).toBeUndefined();
  });
});
