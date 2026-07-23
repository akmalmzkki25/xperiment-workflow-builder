import { describe, expect, test } from 'vitest';
import { buildContext } from '../src/index.js';

describe('buildContext', () => {
  test('shapes the expression context', () => {
    const ctx = buildContext('exec-1', { name: 'Budi' }, { check: { exists: true } });
    expect(ctx).toEqual({
      trigger: { body: { name: 'Budi' } },
      nodes: { check: { output: { exists: true } } },
      execution: { id: 'exec-1' },
    });
  });

  test('handles null trigger body and empty outputs', () => {
    const ctx = buildContext('exec-2', null, {});
    expect(ctx.trigger.body).toBeNull();
    expect(ctx.nodes).toEqual({});
  });
});
