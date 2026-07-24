import { describe, expect, test } from 'vitest';
import { extractJson } from '../src/extract.js';

describe('extractJson', () => {
  test('parses a naked JSON object', () => {
    expect(extractJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  test('unwraps a fenced ```json block', () => {
    const text = 'Here is the workflow:\n```json\n{"schemaVersion":"0.1"}\n```\nDone.';
    expect(extractJson(text)).toEqual({ schemaVersion: '0.1' });
  });

  test('unwraps a bare ``` fence without a language tag', () => {
    expect(extractJson('```\n{"x":true}\n```')).toEqual({ x: true });
  });

  test('finds the first balanced object amid prose', () => {
    const text = 'Sure! {"nodes":[{"id":"a"}],"edges":[]} — hope that helps';
    expect(extractJson(text)).toEqual({ nodes: [{ id: 'a' }], edges: [] });
  });

  test('handles braces inside string values', () => {
    expect(extractJson('{"msg":"Halo {{ trigger.body.name }}"}')).toEqual({
      msg: 'Halo {{ trigger.body.name }}',
    });
  });

  test('throws SyntaxError when no JSON object is present', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(SyntaxError);
    expect(() => extractJson('{ not valid json')).toThrow(SyntaxError);
  });
});
