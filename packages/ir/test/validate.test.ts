import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { validateWorkflow, type RegistryLike } from '../src/index.js';

const fakeRegistry: RegistryLike = {
  get(type: string) {
    const table: Record<string, { kind: 'trigger' | 'action' | 'logic'; ports: string[] }> = {
      'manual.trigger': { kind: 'trigger', ports: ['main'] },
      'core.transform': { kind: 'logic', ports: ['main'] },
      'core.if': { kind: 'logic', ports: ['true', 'false'] },
    };
    const info = table[type];
    if (!info) return undefined;
    return {
      kind: info.kind,
      paramsSchema:
        type === 'core.transform'
          ? z.object({ fields: z.record(z.string(), z.unknown()) }).strict()
          : type === 'core.if'
            ? z.object({ condition: z.unknown() }).strict()
            : z.object({}).strict(),
      defaultEffectClass: 'pure' as const,
      outputPorts: info.ports,
    };
  },
};

interface TestNode {
  id: string;
  kind: string;
  type: string;
  operationVersion: string;
  parameters: Record<string, unknown>;
}

interface TestIr {
  schemaVersion: string;
  workflow: { id: string; name: string };
  entrypoints: string[];
  nodes: TestNode[];
  edges: { id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }[];
}

function baseIr(): TestIr {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_x', name: 'X' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'branch',
        kind: 'logic',
        type: 'core.if',
        operationVersion: '0.1.0',
        parameters: { condition: '{{ trigger.body.total > 100 }}' },
      },
      {
        id: 'big',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { size: 'big' } },
      },
      {
        id: 'small',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { size: 'small' } },
      },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'branch', port: 'input' } },
      { id: 'e2', from: { nodeId: 'branch', port: 'true' }, to: { nodeId: 'big', port: 'input' } },
      { id: 'e3', from: { nodeId: 'branch', port: 'false' }, to: { nodeId: 'small', port: 'input' } },
    ],
  };
}

const validate = (ir: unknown) => validateWorkflow(ir, { registry: fakeRegistry });

describe('validateWorkflow', () => {
  test('valid workflow returns valid with parsed ir and no findings', () => {
    const r = validate(baseIr());
    expect(r.findings).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.ir?.workflow.id).toBe('wf_x');
  });

  test('schema layer: malformed document short-circuits', () => {
    const r = validate({ schemaVersion: '9.9' });
    expect(r.valid).toBe(false);
    expect(r.findings.every((f) => f.layer === 'schema')).toBe(true);
    expect(r.ir).toBeUndefined();
  });

  test('graph: duplicate node ids', () => {
    const ir = baseIr();
    ir.nodes.push({ ...ir.nodes[2]! });
    const r = validate(ir);
    expect(r.findings.some((f) => f.code === 'duplicate_node_id')).toBe(true);
  });

  test('graph: edge references unknown node and unknown port', () => {
    const ir = baseIr();
    ir.edges.push({ id: 'e4', from: { nodeId: 'ghost', port: 'main' }, to: { nodeId: 'big', port: 'input' } });
    ir.edges.push({ id: 'e5', from: { nodeId: 'branch', port: 'maybe' }, to: { nodeId: 'small', port: 'input' } });
    const r = validate(ir);
    expect(r.findings.some((f) => f.code === 'unknown_edge_node')).toBe(true);
    expect(r.findings.some((f) => f.code === 'unknown_output_port')).toBe(true);
  });

  test('graph: entrypoint rules', () => {
    const ir = baseIr();
    ir.entrypoints = ['big'];
    expect(validate(ir).findings.some((f) => f.code === 'entrypoint_not_trigger')).toBe(true);
    const ir2 = baseIr();
    ir2.entrypoints = ['t', 'branch'];
    expect(validate(ir2).findings.some((f) => f.code === 'single_entrypoint_required')).toBe(true);
    const ir3 = baseIr();
    ir3.entrypoints = ['ghost'];
    expect(validate(ir3).findings.some((f) => f.code === 'unknown_entrypoint')).toBe(true);
  });

  test('graph: cycle detection', () => {
    const ir = baseIr();
    ir.edges.push({ id: 'e6', from: { nodeId: 'big', port: 'main' }, to: { nodeId: 'branch', port: 'input' } });
    expect(validate(ir).findings.some((f) => f.code === 'cycle_detected')).toBe(true);
  });

  test('graph: unreachable node', () => {
    const ir = baseIr();
    ir.nodes.push({
      id: 'island',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: {} },
    });
    expect(validate(ir).findings.some((f) => f.code === 'unreachable_node' && f.nodeId === 'island')).toBe(true);
  });

  test('parameters: unknown node type and schema violation', () => {
    const ir = baseIr();
    ir.nodes[2]!.type = 'alien.op';
    expect(validate(ir).findings.some((f) => f.code === 'unknown_node_type' && f.nodeId === 'big')).toBe(true);
    const ir2 = baseIr();
    ir2.nodes[2]!.parameters = { wrong: true };
    expect(validate(ir2).findings.some((f) => f.code === 'invalid_parameters' && f.nodeId === 'big')).toBe(true);
  });

  test('expressions: parse error carries nodeId, path, position', () => {
    const ir = baseIr();
    ir.nodes[1]!.parameters = { condition: '{{ trigger.__proto__ }}' };
    const r = validate(ir);
    const f = r.findings.find((x) => x.code === 'invalid_expression');
    expect(f).toBeDefined();
    expect(f?.nodeId).toBe('branch');
    expect(f?.path).toBe('condition');
    expect(typeof f?.position).toBe('number');
  });
});
