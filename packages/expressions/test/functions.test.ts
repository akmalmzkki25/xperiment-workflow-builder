import { describe, expect, test } from 'vitest';
import {
  evaluate,
  parseExpression,
  ExpressionEvalError,
  FUNCTIONS,
  FUNCTION_NAMES,
  CONTEXT_ROOTS,
  type ExpressionContext,
} from '../src/index.js';

const ctx: ExpressionContext = {
  trigger: {
    body: {
      name: 'Budi Santoso',
      sku: 'ABC-123',
      total: 150000,
      qty: 3,
      tags: ['b', 'a', 'c'],
      prices: [1500, 9900, 250],
      empty: [],
      order: { id: 'o-1', customer: { city: 'Bandung' }, lines: [{ sku: 'x' }, { sku: 'y' }] },
      raw: '{"a":1,"b":[2,3]}',
      equalShapes: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      blank: '',
      zero: 0,
      no: false,
    },
  },
  nodes: {},
  execution: { id: 'exec-1' },
  now: Date.parse('2026-08-08T03:15:00.000Z'),
};

const run = (src: string) => evaluate(parseExpression(src), ctx);

describe('string functions', () => {
  test('split and join round-trip', () => {
    expect(run("split(trigger.body.sku, '-')")).toEqual(['ABC', '123']);
    expect(run("join(split(trigger.body.sku, '-'), '/')")).toBe('ABC/123');
    expect(run("join(trigger.body.prices, ',')")).toBe('1500,9900,250');
  });

  test('split rejects an empty separator', () => {
    expect(() => run("split(trigger.body.sku, '')")).toThrow(ExpressionEvalError);
  });

  test('join refuses element types it cannot render', () => {
    expect(() => run("join(trigger.body.tags, 1)")).toThrow(ExpressionEvalError);
    expect(() => run("join(trigger.body.order.lines, ',')")).toThrow(ExpressionEvalError);
  });

  test('replace replaces every occurrence and rejects an empty needle', () => {
    expect(run("replace('a-b-c', '-', '+')")).toBe('a+b+c');
    expect(run("replace(trigger.body.name, 'o', '0')")).toBe('Budi Sant0s0');
    expect(() => run("replace('abc', '', 'x')")).toThrow(ExpressionEvalError);
  });

  test('slice works on strings and arrays with negative indices', () => {
    expect(run("slice(trigger.body.sku, 0, 3)")).toBe('ABC');
    expect(run("slice(trigger.body.sku, -3)")).toBe('123');
    expect(run('slice(trigger.body.tags, 1)')).toEqual(['a', 'c']);
    expect(run('slice(trigger.body.tags, 0, -1)')).toEqual(['b', 'a']);
  });

  test('contains does substring on strings and strict membership on arrays', () => {
    expect(run("contains(trigger.body.name, 'Santoso')")).toBe(true);
    expect(run("contains(trigger.body.name, 'santoso')")).toBe(false);
    expect(run("contains(trigger.body.tags, 'a')")).toBe(true);
    expect(run('contains(trigger.body.prices, 1500)')).toBe(true);
    expect(run("contains(trigger.body.prices, '1500')")).toBe(false);
  });

  test('startsWith and endsWith', () => {
    expect(run("startsWith(trigger.body.sku, 'ABC')")).toBe(true);
    expect(run("endsWith(trigger.body.sku, '123')")).toBe(true);
    expect(run("startsWith(trigger.body.sku, 'xyz')")).toBe(false);
  });

  test('padStart and padEnd refuse an absurd target length', () => {
    expect(run("padStart('7', 3, '0')")).toBe('007');
    expect(run("padEnd('7', 3, '.')")).toBe('7..');
    expect(run("padStart('7', 3)")).toBe('  7');
    // An expression must not be able to allocate a gigabyte.
    expect(() => run("padStart('7', 100000, '0')")).toThrow(ExpressionEvalError);
  });
});

describe('number functions', () => {
  test('round is half-away-from-zero and honours decimal places', () => {
    expect(run('round(2.5)')).toBe(3);
    // JS Math.round(-2.5) is -2, which is asymmetric. Money must not round that way.
    expect(run('round(0 - 2.5)')).toBe(-3);
    expect(run('round(2.4)')).toBe(2);
    expect(run('round(1.2345, 2)')).toBe(1.23);
    expect(run('round(trigger.body.total * 0.11, 0)')).toBe(16500);
  });

  test('floor, ceil and abs', () => {
    expect(run('floor(2.9)')).toBe(2);
    expect(run('ceil(2.1)')).toBe(3);
    expect(run('abs(0 - 7)')).toBe(7);
  });

  test('min and max accept an array or two-or-more scalars', () => {
    expect(run('min(trigger.body.prices)')).toBe(250);
    expect(run('max(trigger.body.prices)')).toBe(9900);
    expect(run('min(3, 1, 2)')).toBe(1);
    expect(run('max(3, 1, 2)')).toBe(3);
  });

  test('min, max and avg of nothing throw; sum of nothing is zero', () => {
    // There is no identity for min/max/avg, and Infinity would smuggle a
    // non-finite value into a language that otherwise forbids one.
    expect(() => run('min(trigger.body.empty)')).toThrow(ExpressionEvalError);
    expect(() => run('max(trigger.body.empty)')).toThrow(ExpressionEvalError);
    expect(() => run('avg(trigger.body.empty)')).toThrow(ExpressionEvalError);
    expect(run('sum(trigger.body.empty)')).toBe(0);
  });

  test('sum and avg require finite numbers', () => {
    expect(run('sum(trigger.body.prices)')).toBe(11650);
    expect(run('avg(trigger.body.prices)')).toBeCloseTo(3883.333333, 5);
    expect(() => run('sum(trigger.body.tags)')).toThrow(ExpressionEvalError);
  });

  test('toFixed returns a string', () => {
    expect(run('toFixed(1.005, 1)')).toBe('1.0');
    expect(run('toFixed(trigger.body.total, 2)')).toBe('150000.00');
  });

  test('formatIDR renders Indonesian thousands separators', () => {
    const out = run('formatIDR(trigger.body.total)') as string;
    expect(out).toContain('150.000');
    expect(out).toMatch(/^Rp/);
    expect(run('formatIDR(0)')).toMatch(/0$/);
  });
});

describe('collection functions', () => {
  test('first and last return null on an empty array', () => {
    expect(run('first(trigger.body.tags)')).toBe('b');
    expect(run('last(trigger.body.tags)')).toBe('c');
    expect(run('first(trigger.body.empty)')).toBeNull();
    expect(run('last(trigger.body.empty)')).toBeNull();
  });

  test('keys and values are sorted for determinism', () => {
    expect(run('keys(trigger.body.order)')).toEqual(['customer', 'id', 'lines']);
    expect(run('keys(trigger.body.order.customer)')).toEqual(['city']);
    expect(run('values(trigger.body.order.customer)')).toEqual(['Bandung']);
  });

  test('unique deduplicates primitives and structurally equal objects', () => {
    expect(run("unique(split('a,b,a,c', ','))")).toEqual(['a', 'b', 'c']);
    expect(run('unique(trigger.body.order.lines)')).toEqual([{ sku: 'x' }, { sku: 'y' }]);
    // The structural half of the claim needs input that actually contains a duplicate —
    // and one written with its keys in a different order.
    expect(run('unique(trigger.body.equalShapes)')).toEqual([{ a: 1, b: 2 }]);
  });

  test('sort orders strings by code unit, not by locale', () => {
    // 'b','a','c' sorts identically under either rule, so it proves nothing. Capitals do:
    // localeCompare puts 'a' before 'B'; code-unit order puts 'B' first.
    expect(run("sort(split('a,B,apple,Zoo', ','))")).toEqual(['B', 'Zoo', 'a', 'apple']);
  });

  test('sort returns a NEW array, leaves the input alone, and refuses mixed types', () => {
    expect(run('sort(trigger.body.tags)')).toEqual(['a', 'b', 'c']);
    expect(run("sort(trigger.body.prices, 'desc')")).toEqual([9900, 1500, 250]);
    // resolvedParams is written to input_json; mutating it would corrupt the trace.
    expect(run('trigger.body.tags')).toEqual(['b', 'a', 'c']);
    expect(() => run('sort(trigger.body.order.lines)')).toThrow(ExpressionEvalError);
  });

  test('reverse returns a NEW array', () => {
    expect(run('reverse(trigger.body.tags)')).toEqual(['c', 'a', 'b']);
    expect(run('trigger.body.tags')).toEqual(['b', 'a', 'c']);
  });

  test('indexOf uses strict equality', () => {
    expect(run("indexOf(trigger.body.tags, 'a')")).toBe(1);
    expect(run("indexOf(trigger.body.tags, 'zz')")).toBe(-1);
    expect(run("indexOf(trigger.body.prices, '1500')")).toBe(-1);
  });

  test('isEmpty is about containers, not falsiness', () => {
    expect(run('isEmpty(trigger.body.empty)')).toBe(true);
    expect(run('isEmpty(trigger.body.blank)')).toBe(true);
    expect(run('isEmpty(trigger.body.missing)')).toBe(true);
    expect(run('isEmpty(trigger.body.tags)')).toBe(false);
    // 0 and false are values, not empty containers.
    expect(run('isEmpty(trigger.body.zero)')).toBe(false);
    expect(run('isEmpty(trigger.body.no)')).toBe(false);
  });
});

describe('object and json functions', () => {
  test('get walks a dotted path including array indices', () => {
    expect(run("get(trigger.body, 'order.customer.city', 'unknown')")).toBe('Bandung');
    expect(run("get(trigger.body, 'order.lines.1.sku', 'none')")).toBe('y');
  });

  test('get returns the default for a missing path — the dynamic-index escape hatch', () => {
    expect(run("get(trigger.body, 'order.customer.zip', 'n/a')")).toBe('n/a');
    expect(run("get(trigger.body, 'nope.deeper', 0)")).toBe(0);
    expect(run("get(trigger.body.zero, 'anything', 'fallback')")).toBe('fallback');
  });

  test('get refuses a forbidden path segment', () => {
    expect(() => run("get(trigger.body, '__proto__', 'x')")).toThrow(ExpressionEvalError);
    expect(() => run("get(trigger.body, 'order.constructor', 'x')")).toThrow(ExpressionEvalError);
  });

  test('has distinguishes a missing key from a null value', () => {
    expect(run("has(trigger.body, 'order.id')")).toBe(true);
    expect(run("has(trigger.body, 'order.nope')")).toBe(false);
    expect(run("has(trigger.body, 'zero')")).toBe(true);
  });

  test('jsonParse reads a payload and rejects malformed input', () => {
    expect(run('jsonParse(trigger.body.raw)')).toEqual({ a: 1, b: [2, 3] });
    expect(() => run("jsonParse('{oops')")).toThrow(ExpressionEvalError);
  });

  test('jsonStringify sorts keys so output is byte-stable', () => {
    expect(run('jsonStringify(trigger.body.order.customer)')).toBe('{"city":"Bandung"}');
    expect(run('jsonStringify(jsonParse(trigger.body.raw))')).toBe('{"a":1,"b":[2,3]}');
    // Insertion order must not leak into the output.
    expect(run("jsonStringify(jsonParse('{\"b\":1,\"a\":2}'))")).toBe('{"a":2,"b":1}');
  });

  test('coalesce returns the first non-null and default is callable', () => {
    expect(run("coalesce(trigger.body.missing, trigger.body.blank, 'x')")).toBe('');
    expect(run("coalesce(trigger.body.missing, 'x')")).toBe('x');
    // `default` looks like a keyword but the parser only special-cases true/false/null.
    expect(run("default(trigger.body.missing, 'fallback')")).toBe('fallback');
    expect(run("default(trigger.body.zero, 99)")).toBe(0);
  });
});

describe('registry invariants', () => {
  /** The only functions that legitimately take nothing. Everything else must refuse. */
  const ZERO_ARITY = new Set(['now', 'today']);

  test('every FUNCTIONS entry is arity-checked', () => {
    for (const name of FUNCTION_NAMES) {
      if (ZERO_ARITY.has(name)) continue;
      expect(() => FUNCTIONS[name]!([], ctx), `${name}() with no arguments`).toThrow(ExpressionEvalError);
    }
  });

  test('even a zero-arity function refuses too many arguments', () => {
    const tooMany = new Array<unknown>(12).fill('x');
    for (const name of FUNCTION_NAMES) {
      expect(() => FUNCTIONS[name]!(tooMany, ctx), `${name}() with twelve arguments`).toThrow(ExpressionEvalError);
    }
  });

  test('FUNCTION_NAMES matches the FUNCTIONS keys', () => {
    expect([...FUNCTION_NAMES].sort()).toEqual(Object.keys(FUNCTIONS).sort());
  });

  test('no function name shadows a context root', () => {
    for (const root of CONTEXT_ROOTS) {
      expect(FUNCTION_NAMES.has(root)).toBe(false);
    }
  });

  test('every function type-checks its arguments rather than coercing', () => {
    expect(() => run('upper(trigger.body.total)')).toThrow(ExpressionEvalError);
    expect(() => run("startsWith(trigger.body.total, '1')")).toThrow(ExpressionEvalError);
    expect(() => run('first(trigger.body.name)')).toThrow(ExpressionEvalError);
    expect(() => run('keys(trigger.body.tags)')).toThrow(ExpressionEvalError);
    expect(() => run('round(trigger.body.name)')).toThrow(ExpressionEvalError);
  });
});
