import { describe, expect, test } from 'vitest';
import { parseExpression, ExpressionParseError } from '../src/index.js';

describe('parseExpression', () => {
  test('parses a property chain', () => {
    expect(parseExpression('trigger.body.name')).toEqual({
      type: 'chain',
      parts: ['trigger', 'body', 'name'],
    });
  });

  test('parses bracket string access', () => {
    expect(parseExpression('nodes.check.output["total price"]')).toEqual({
      type: 'chain',
      parts: ['nodes', 'check', 'output', 'total price'],
    });
  });

  test('parses literals', () => {
    expect(parseExpression("'abc'")).toEqual({ type: 'lit', value: 'abc' });
    expect(parseExpression('"abc"')).toEqual({ type: 'lit', value: 'abc' });
    expect(parseExpression('42')).toEqual({ type: 'lit', value: 42 });
    expect(parseExpression('4.5')).toEqual({ type: 'lit', value: 4.5 });
    expect(parseExpression('true')).toEqual({ type: 'lit', value: true });
    expect(parseExpression('false')).toEqual({ type: 'lit', value: false });
    expect(parseExpression('null')).toEqual({ type: 'lit', value: null });
  });

  test('parses comparison and equality operators', () => {
    expect(parseExpression('trigger.body.n >= 3')).toEqual({
      type: 'binary',
      op: '>=',
      left: { type: 'chain', parts: ['trigger', 'body', 'n'] },
      right: { type: 'lit', value: 3 },
    });
    expect(parseExpression("trigger.body.s != 'x'").type).toBe('binary');
  });

  test('boolean precedence: && binds tighter than ||', () => {
    const ast = parseExpression('trigger.body.a == 1 && trigger.body.b == 2 || trigger.body.c == 3');
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.op).toBe('||');
      expect(ast.left.type).toBe('binary');
      if (ast.left.type === 'binary') expect(ast.left.op).toBe('&&');
    }
  });

  test('?? has lowest precedence', () => {
    const ast = parseExpression("trigger.body.x ?? 'default'");
    expect(ast).toEqual({
      type: 'binary',
      op: '??',
      left: { type: 'chain', parts: ['trigger', 'body', 'x'] },
      right: { type: 'lit', value: 'default' },
    });
  });

  test('parentheses group', () => {
    const ast = parseExpression('!(trigger.body.a && trigger.body.b)');
    expect(ast.type).toBe('unary');
  });

  test('parses whitelisted function calls', () => {
    expect(parseExpression('lower(trigger.body.name)')).toEqual({
      type: 'call',
      name: 'lower',
      args: [{ type: 'chain', parts: ['trigger', 'body', 'name'] }],
    });
  });

  test('rejects forbidden identifiers with position', () => {
    for (const bad of ['trigger.__proto__', 'trigger.constructor.x', 'nodes.a.output.prototype']) {
      expect(() => parseExpression(bad)).toThrow(ExpressionParseError);
    }
    try {
      parseExpression('trigger.__proto__');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionParseError);
      expect((e as ExpressionParseError).position).toBe(8);
    }
  });

  test('rejects bracket access to forbidden identifiers', () => {
    expect(() => parseExpression('trigger["__proto__"]')).toThrow(ExpressionParseError);
  });

  test('rejects unknown functions', () => {
    expect(() => parseExpression('eval(trigger.body)')).toThrow(ExpressionParseError);
    expect(() => parseExpression('fetch("http://x")')).toThrow(ExpressionParseError);
  });

  test('rejects invalid syntax', () => {
    expect(() => parseExpression('')).toThrow(ExpressionParseError);
    expect(() => parseExpression('a = 1')).toThrow(ExpressionParseError);
    expect(() => parseExpression("'unterminated")).toThrow(ExpressionParseError);
    expect(() => parseExpression('trigger.')).toThrow(ExpressionParseError);
    expect(() => parseExpression('1 +')).toThrow(ExpressionParseError);
  });

  test('parses additive and multiplicative with mul binding tighter', () => {
    expect(parseExpression('2 + 3 * 4')).toEqual({
      type: 'binary',
      op: '+',
      left: { type: 'lit', value: 2 },
      right: {
        type: 'binary',
        op: '*',
        left: { type: 'lit', value: 3 },
        right: { type: 'lit', value: 4 },
      },
    });
  });

  test('unary minus binds tighter than multiplication', () => {
    expect(parseExpression('-2 * 3')).toEqual({
      type: 'binary',
      op: '*',
      left: { type: 'unary', op: '-', operand: { type: 'lit', value: 2 } },
      right: { type: 'lit', value: 3 },
    });
  });

  test('arithmetic binds tighter than relational', () => {
    const ast = parseExpression('1 + 2 > 2');
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.op).toBe('>');
      expect(ast.left.type).toBe('binary');
      if (ast.left.type === 'binary') expect(ast.left.op).toBe('+');
    }
  });

  test('tokenizes an operator with no surrounding space', () => {
    expect(parseExpression('1-2')).toEqual({
      type: 'binary',
      op: '-',
      left: { type: 'lit', value: 1 },
      right: { type: 'lit', value: 2 },
    });
  });

  test('parses a right-associative ternary', () => {
    expect(parseExpression('true ? 1 : false ? 2 : 3')).toEqual({
      type: 'cond',
      test: { type: 'lit', value: true },
      consequent: { type: 'lit', value: 1 },
      alternate: {
        type: 'cond',
        test: { type: 'lit', value: false },
        consequent: { type: 'lit', value: 2 },
        alternate: { type: 'lit', value: 3 },
      },
    });
  });

  test('ternary is looser than ?? and ||', () => {
    const ast = parseExpression("trigger.body.x ?? 'd' ? 1 : 2");
    expect(ast.type).toBe('cond');
    if (ast.type === 'cond') {
      expect(ast.test.type).toBe('binary');
      if (ast.test.type === 'binary') expect(ast.test.op).toBe('??');
    }
  });

  test('parses a ternary inside parentheses and inside call arguments', () => {
    expect(parseExpression('(true ? 1 : 2)').type).toBe('cond');
    const call = parseExpression("lower(true ? 'A' : 'B')");
    expect(call.type).toBe('call');
    if (call.type === 'call') expect(call.args[0]!.type).toBe('cond');
  });

  test('parses numeric bracket indexing', () => {
    expect(parseExpression('trigger.body.tags[0]')).toEqual({
      type: 'chain',
      parts: ['trigger', 'body', 'tags', '0'],
    });
  });

  test('rejects a dynamic or negative bracket index', () => {
    // A dynamic index would put an Ast in a value position; get() is the escape hatch.
    expect(() => parseExpression('trigger.body.tags[trigger.body.i]')).toThrow(ExpressionParseError);
    expect(() => parseExpression('trigger.body.tags[-1]')).toThrow(ExpressionParseError);
    expect(() => parseExpression('trigger.body.tags[1.5]')).toThrow(ExpressionParseError);
  });

  test('rejects a dangling ternary without a colon', () => {
    expect(() => parseExpression('true ? 1')).toThrow(ExpressionParseError);
  });
});
