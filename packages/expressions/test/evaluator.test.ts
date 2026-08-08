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

  test('arithmetic on two numbers', () => {
    expect(run('2 + 3')).toBe(5);
    expect(run('10 - 4')).toBe(6);
    expect(run('3 * 4')).toBe(12);
    expect(run('10 / 4')).toBe(2.5);
    expect(run('10 % 3')).toBe(1);
    // The motivating case: 11% VAT on an order total.
    expect(run('trigger.body.total * 1.11')).toBeCloseTo(166.5, 10);
  });

  test('plus concatenates two strings and refuses mixed operands', () => {
    expect(run("'a' + 'b'")).toBe('ab');
    expect(run("trigger.body.name + '!'")).toBe('Budi!');
    expect(() => run('trigger.body.name + 1')).toThrow(ExpressionEvalError);
    expect(() => run('1 + trigger.body.name')).toThrow(ExpressionEvalError);
  });

  test('minus, times, divide and modulo require two numbers', () => {
    expect(() => run("'a' - 'b'")).toThrow(ExpressionEvalError);
    expect(() => run("'a' * 2")).toThrow(ExpressionEvalError);
    expect(() => run('trigger.body.vip / 2')).toThrow(ExpressionEvalError);
    expect(() => run('trigger.body.missing % 2')).toThrow(ExpressionEvalError);
  });

  test('division and modulo by zero throw rather than yielding Infinity or NaN', () => {
    expect(() => run('1 / 0')).toThrow(ExpressionEvalError);
    expect(() => run('0 / 0')).toThrow(ExpressionEvalError);
    expect(() => run('1 % 0')).toThrow(ExpressionEvalError);
  });

  test('arithmetic overflow throws rather than yielding Infinity', () => {
    // JSON.stringify(Infinity) is null, so a non-finite value would corrupt an
    // output payload silently. It must never enter the value space.
    const oneE308 = `1${'0'.repeat(308)}`;
    expect(run(oneE308)).toBe(1e308);
    expect(() => run(`${oneE308} * 10`)).toThrow(ExpressionEvalError);
  });

  test('modulo follows the dividend sign', () => {
    expect(run('-7 % 3')).toBe(-1);
    expect(run('7 % -3')).toBe(1);
  });

  test('unary minus negates numbers and refuses everything else', () => {
    expect(run('-trigger.body.total')).toBe(-150);
    expect(run('0 - -5')).toBe(5);
    expect(() => run('-trigger.body.name')).toThrow(ExpressionEvalError);
    expect(() => run('-trigger.body.vip')).toThrow(ExpressionEvalError);
  });

  test('ternary picks a branch by truthiness and evaluates only that branch', () => {
    expect(run("trigger.body.vip ? 'gold' : 'basic'")).toBe('gold');
    expect(run("nodes.check.output.exists ? 'yes' : 'no'")).toBe('no');
    // The untaken branch is never evaluated, so this would-be type error is harmless.
    expect(run('trigger.body.vip ? 1 : trigger.body.name - 1')).toBe(1);
    expect(run('nodes.check.output.exists ? trigger.body.name - 1 : 2')).toBe(2);
  });

  test('numeric index reads an array element and is null out of range', () => {
    expect(run('trigger.body.tags[0]')).toBe('a');
    expect(run('trigger.body.tags[1]')).toBe('b');
    expect(run('trigger.body.tags[9]')).toBeNull();
    expect(run('length(trigger.body.tags[0])')).toBe(1);
  });

  test('toNumber refuses a value that is not finite', () => {
    expect(() => run("toNumber('1e999')")).toThrow(ExpressionEvalError);
    expect(() => run("toNumber('Infinity')")).toThrow(ExpressionEvalError);
    expect(run("toNumber('42')")).toBe(42);
  });
});
