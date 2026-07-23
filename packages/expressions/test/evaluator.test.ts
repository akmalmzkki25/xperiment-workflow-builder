import { describe, expect, test } from 'vitest';
import { evaluate, parseExpression, ExpressionEvalError, type ExpressionContext } from '../src/index.js';

const ctx: ExpressionContext = {
  trigger: { body: { name: 'Budi', phone: '0812', total: 150, vip: true, tags: ['a', 'b'] } },
  nodes: { check: { output: { exists: false, count: 0 } } },
  execution: { id: 'exec-1' },
};

const run = (src: string) => evaluate(parseExpression(src), ctx);

describe('evaluate', () => {
  test('resolves chains from all three roots', () => {
    expect(run('trigger.body.name')).toBe('Budi');
    expect(run('nodes.check.output.exists')).toBe(false);
    expect(run('execution.id')).toBe('exec-1');
  });

  test('safe navigation: missing property yields null', () => {
    expect(run('trigger.body.missing')).toBeNull();
    expect(run('trigger.body.missing.deeper')).toBeNull();
    expect(run('trigger.body.name.foo')).toBeNull(); // property of primitive -> null
  });

  test('unknown root throws', () => {
    expect(() => run('variables.X')).toThrow(ExpressionEvalError);
  });

  test('equality is strict', () => {
    expect(run("trigger.body.name == 'Budi'")).toBe(true);
    expect(run('trigger.body.total == 150')).toBe(true);
    expect(run("trigger.body.total == '150'")).toBe(false);
    expect(run('trigger.body.missing == null')).toBe(true);
  });

  test('relational operators require matching primitive types', () => {
    expect(run('trigger.body.total > 100')).toBe(true);
    expect(run("trigger.body.name < 'Zed'")).toBe(true);
    expect(() => run("trigger.body.total > 'x'")).toThrow(ExpressionEvalError);
    expect(() => run('trigger.body.vip > 1')).toThrow(ExpressionEvalError);
  });

  test('boolean ops use truthiness, ! negates', () => {
    expect(run('trigger.body.vip && trigger.body.total > 100')).toBe(true);
    expect(run('nodes.check.output.exists || trigger.body.vip')).toBe(true);
    expect(run('!nodes.check.output.exists')).toBe(true);
  });

  test('?? only coalesces null/undefined', () => {
    expect(run("trigger.body.missing ?? 'fallback'")).toBe('fallback');
    expect(run('nodes.check.output.count ?? 99')).toBe(0);
  });

  test('functions work and type-check their arguments', () => {
    expect(run('lower(trigger.body.name)')).toBe('budi');
    expect(run('upper(trigger.body.name)')).toBe('BUDI');
    expect(run("trim('  x  ')")).toBe('x');
    expect(run('length(trigger.body.name)')).toBe(4);
    expect(run('length(trigger.body.tags)')).toBe(2);
    expect(run("toNumber('42')")).toBe(42);
    expect(run('toString(150)')).toBe('150');
    expect(() => run('lower(trigger.body.total)')).toThrow(ExpressionEvalError);
    expect(() => run("toNumber('abc')")).toThrow(ExpressionEvalError);
    expect(() => run('length(trigger.body.vip)')).toThrow(ExpressionEvalError);
    expect(() => run('lower()')).toThrow(ExpressionEvalError);
  });
});
