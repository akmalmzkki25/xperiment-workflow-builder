import { describe, expect, test } from 'vitest';
import { expressionPaths } from '../src/lib/samplePaths';

const paths = (sample: unknown, options = {}) => expressionPaths(sample, options).map((p) => p.path);

describe('expressionPaths', () => {
  test('walks nested objects into dotted paths', () => {
    expect(paths({ body: { customer: { name: 'Budi' } } })).toEqual([
      'trigger.body',
      'trigger.body.customer',
      'trigger.body.customer.name',
    ]);
  });

  test('offers containers as well as leaves', () => {
    // `{{ trigger.body.items }}` is what feeds a loop; offering only leaves would hide
    // the single most useful path in the payload.
    expect(paths({ body: { items: [{ sku: 'A' }] } })).toContain('trigger.body.items');
  });

  test('descends only the first array element', () => {
    // A hundred rows of identical shape would otherwise be a hundred identical
    // suggestions. The author wants the shape, not the data.
    const out = paths({ items: [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }] });
    expect(out).toContain('trigger.items[0].sku');
    expect(out.some((p) => p.includes('[1]'))).toBe(false);
  });

  test('an empty array contributes only itself', () => {
    expect(paths({ items: [] })).toEqual(['trigger.items']);
  });

  test('brackets and quotes a key that is not a bare identifier', () => {
    const out = paths({ 'order id': 1, 'a-b': 2, ok_1: 3 });
    expect(out).toContain('trigger["order id"]');
    expect(out).toContain('trigger["a-b"]');
    expect(out).toContain('trigger.ok_1');
  });

  test('a key that would need escaping is still valid JSON inside the brackets', () => {
    expect(paths({ 'we"ird': 1 })).toContain('trigger["we\\"ird"]');
  });

  test('the root itself is not offered', () => {
    expect(paths({ a: 1 })).not.toContain('trigger');
  });

  test('honours a custom root', () => {
    expect(paths({ a: 1 }, { root: 'nodes.hook.output' })).toEqual(['nodes.hook.output.a']);
  });

  test('a primitive payload yields nothing to point at', () => {
    expect(paths('just a string')).toEqual([]);
    expect(paths(null)).toEqual([]);
    expect(paths(42)).toEqual([]);
  });

  test('stops at the depth cap instead of recursing forever', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const out = paths(deep, { maxDepth: 3 });
    expect(out).toContain('trigger.a.b.c');
    expect(out.some((p) => p.includes('.d'))).toBe(false);
  });

  test('stops at the path cap on a wide payload', () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(paths(wide, { maxPaths: 10 })).toHaveLength(10);
  });

  test('a deeply nested structure cannot blow the cap', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 200; i += 1) nested = { down: nested };
    expect(() => expressionPaths(nested)).not.toThrow();
    expect(expressionPaths(nested).length).toBeLessThanOrEqual(200);
  });
});

describe('previews', () => {
  const preview = (sample: unknown, path: string) =>
    expressionPaths(sample).find((p) => p.path === path)?.preview;

  test('describes containers by size rather than dumping them', () => {
    expect(preview({ items: [1, 2, 3] }, 'trigger.items')).toBe('array of 3');
    expect(preview({ o: { a: 1, b: 2 } }, 'trigger.o')).toBe('object with 2 keys');
    expect(preview({ o: { a: 1 } }, 'trigger.o')).toBe('object with 1 key');
  });

  test('shows primitives as they would appear in an expression', () => {
    expect(preview({ n: 150 }, 'trigger.n')).toBe('150');
    expect(preview({ s: 'Budi' }, 'trigger.s')).toBe('"Budi"');
    expect(preview({ b: true }, 'trigger.b')).toBe('true');
    expect(preview({ z: null }, 'trigger.z')).toBe('null');
  });

  test('truncates a long string rather than pasting a whole document into the list', () => {
    const long = preview({ s: 'x'.repeat(500) }, 'trigger.s')!;
    expect(long.length).toBeLessThan(60);
    expect(long.endsWith('…')).toBe(true);
  });
});
