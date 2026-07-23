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
    expect(() => parseExpression('1 + 1')).toThrow(ExpressionParseError); // arithmetic not in v0
  });
});
