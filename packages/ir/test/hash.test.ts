import { describe, expect, test } from 'vitest';
import { canonicalHash, workflowIrSchema } from '../src/index.js';
import { validIr } from './schema.test.js';

describe('canonicalHash', () => {
  test('is stable across key order', () => {
    const a = workflowIrSchema.parse(validIr);
    const reordered = JSON.parse(JSON.stringify(validIr)) as typeof validIr;
    const w = reordered.workflow;
    reordered.workflow = { name: w.name, id: w.id } as typeof w;
    const b = workflowIrSchema.parse(reordered);
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    expect(canonicalHash(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('changes when content changes', () => {
    const a = workflowIrSchema.parse(validIr);
    const changed = structuredClone(validIr);
    changed.workflow.name = 'Other';
    const b = workflowIrSchema.parse(changed);
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
  });
});
