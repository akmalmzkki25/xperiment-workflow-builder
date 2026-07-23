import { describe, expect, test } from 'vitest';
import { workflowIrSchema } from '../src/index.js';

export const validIr = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_demo', name: 'Demo' },
  entrypoints: ['trigger_1'],
  nodes: [
    {
      id: 'trigger_1',
      kind: 'trigger',
      type: 'manual.trigger',
      operationVersion: '0.1.0',
      parameters: {},
    },
    {
      id: 'greet',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: { message: 'Halo {{ trigger.body.name }}' } },
      settings: { timeoutMs: 5000, retry: { maxAttempts: 1 } },
    },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'trigger_1', port: 'main' }, to: { nodeId: 'greet', port: 'input' } },
  ],
};

describe('workflowIrSchema', () => {
  test('accepts a valid IR', () => {
    const r = workflowIrSchema.safeParse(validIr);
    expect(r.success).toBe(true);
  });

  test('rejects wrong schemaVersion', () => {
    const r = workflowIrSchema.safeParse({ ...validIr, schemaVersion: '1.0' });
    expect(r.success).toBe(false);
  });

  test('rejects bad node kind with issue path', () => {
    const bad = structuredClone(validIr) as { nodes: Record<string, unknown>[] };
    bad.nodes[0]!['kind'] = 'magic';
    const r = workflowIrSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'nodes.0.kind')).toBe(true);
    }
  });

  test('rejects invalid node id format', () => {
    const bad = structuredClone(validIr) as { nodes: { id: string }[] };
    bad.nodes[0]!.id = '1 bad id!';
    expect(workflowIrSchema.safeParse(bad).success).toBe(false);
  });

  test('rejects invalid effectClass and zero maxAttempts', () => {
    const bad = structuredClone(validIr) as { nodes: Record<string, unknown>[] };
    bad.nodes[1]!['effectClass'] = 'destructive';
    expect(workflowIrSchema.safeParse(bad).success).toBe(false);
    const bad2 = structuredClone(validIr) as { nodes: { settings?: { retry?: { maxAttempts: number } } }[] };
    bad2.nodes[1]!.settings = { retry: { maxAttempts: 0 } };
    expect(workflowIrSchema.safeParse(bad2).success).toBe(false);
  });
});
