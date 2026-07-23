import { describe, expect, test } from 'vitest';
import { resolveTemplate, ExpressionEvalError, type ExpressionContext } from '../src/index.js';

const ctx: ExpressionContext = {
  trigger: { body: { name: 'Budi', total: 150, nested: { a: 1 } } },
  nodes: {},
  execution: { id: 'exec-1' },
};

describe('resolveTemplate', () => {
  test('whole-string single expression returns raw value (any type)', () => {
    expect(resolveTemplate('{{ trigger.body.total }}', ctx)).toBe(150);
    expect(resolveTemplate('{{ trigger.body.nested }}', ctx)).toEqual({ a: 1 });
    expect(resolveTemplate('{{ trigger.body.missing }}', ctx)).toBeNull();
  });

  test('interpolation stringifies; null becomes empty string', () => {
    expect(resolveTemplate('Halo {{ trigger.body.name }}!', ctx)).toBe('Halo Budi!');
    expect(resolveTemplate('v={{ trigger.body.missing }}.', ctx)).toBe('v=.');
    expect(resolveTemplate('t={{ trigger.body.total }} n={{ trigger.body.name }}', ctx)).toBe('t=150 n=Budi');
  });

  test('plain values pass through untouched', () => {
    expect(resolveTemplate('no expressions', ctx)).toBe('no expressions');
    expect(resolveTemplate(42, ctx)).toBe(42);
    expect(resolveTemplate(true, ctx)).toBe(true);
    expect(resolveTemplate(null, ctx)).toBeNull();
  });

  test('deep-resolves objects and arrays into NEW structures', () => {
    const input = { a: '{{ trigger.body.name }}', b: ['{{ trigger.body.total }}', 'x'], c: { d: 1 } };
    const out = resolveTemplate(input, ctx) as Record<string, unknown>;
    expect(out).toEqual({ a: 'Budi', b: [150, 'x'], c: { d: 1 } });
    expect(out).not.toBe(input);
    expect(out['c']).not.toBe(input.c); // immutability: fresh objects
    expect(input.a).toBe('{{ trigger.body.name }}'); // input untouched
  });

  test('propagates evaluation errors', () => {
    expect(() => resolveTemplate('{{ lower(trigger.body.total) }}', ctx)).toThrow(ExpressionEvalError);
  });
});
