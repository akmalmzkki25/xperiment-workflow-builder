import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { validateWorkflow, type RegistryLike } from '../src/index.js';

const fakeRegistry: RegistryLike = {
  get(type: string) {
    const table: Record<string, { kind: 'trigger' | 'action' | 'logic'; ports: string[] }> = {
      'manual.trigger': { kind: 'trigger', ports: ['main'] },
      'core.transform': { kind: 'logic', ports: ['main'] },
      'core.if': { kind: 'logic', ports: ['true', 'false'] },
      'core.loop': { kind: 'logic', ports: ['item', 'done'] },
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
            : type === 'core.loop'
              ? z.object({ items: z.unknown() }).strict()
              : z.object({}).strict(),
      defaultEffectClass: 'pure' as const,
      outputPorts: info.ports,
    };
  },
};

interface TestNode {
  scope?: { loopId: string };
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

describe('loop scopes', () => {
  /** t → lp, lp --item--> b (scoped), lp --done--> after */
  function loopIr(): TestIr {
    return {
      schemaVersion: '0.1',
      workflow: { id: 'wf_lp', name: 'Loop' },
      entrypoints: ['t'],
      nodes: [
        { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
        { id: 'lp', kind: 'logic', type: 'core.loop', operationVersion: '0.1.0', parameters: { items: [] } },
        {
          id: 'b',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: { fields: {} },
          scope: { loopId: 'lp' },
        },
        { id: 'after', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: {} } },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'lp', port: 'input' } },
        { id: 'e2', from: { nodeId: 'lp', port: 'item' }, to: { nodeId: 'b', port: 'input' } },
        { id: 'e3', from: { nodeId: 'lp', port: 'done' }, to: { nodeId: 'after', port: 'input' } },
      ],
    };
  }

  const codes = (ir: TestIr) => validate(ir).findings.map((f) => f.code);

  test('a one-node body is valid', () => {
    // The single body node is both the scope's entry and its exit.
    expect(codes(loopIr())).toEqual([]);
  });

  test('a two-node body chain is valid', () => {
    const ir = loopIr();
    ir.nodes.push({
      id: 'b2',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: {} },
      scope: { loopId: 'lp' },
    });
    ir.edges.push({ id: 'e4', from: { nodeId: 'b', port: 'main' }, to: { nodeId: 'b2', port: 'input' } });
    expect(codes(ir)).toEqual([]);
  });

  test('a scoped node may not be the entrypoint', () => {
    const ir = loopIr();
    ir.entrypoints = ['b'];
    expect(codes(ir)).toContain('scoped_node_as_entrypoint');
  });

  test('scope must name a core.loop node', () => {
    const ir = loopIr();
    ir.nodes = ir.nodes.map((n) => (n.id === 'b' ? { ...n, scope: { loopId: 'after' } } : n));
    expect(codes(ir)).toContain('unknown_loop_scope');
  });

  test('a loop with no body is rejected', () => {
    const ir = loopIr();
    ir.nodes = ir.nodes.filter((n) => n.id !== 'b');
    ir.edges = ir.edges.filter((e) => e.to.nodeId !== 'b');
    expect(codes(ir)).toContain('empty_loop_body');
  });

  test('an edge may not leave a loop body', () => {
    // An error branch inside a loop must stay inside it; expansion cannot clone a node that
    // lives outside the scope.
    const ir = loopIr();
    ir.edges.push({ id: 'e4', from: { nodeId: 'b', port: 'main' }, to: { nodeId: 'after', port: 'input' } });
    expect(codes(ir)).toContain('cross_scope_edge');
  });

  test('an edge may not enter a loop body except the loop own item edge', () => {
    const ir = loopIr();
    ir.edges.push({ id: 'e4', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'b', port: 'input' } });
    expect(codes(ir)).toContain('cross_scope_edge');
  });

  test('a loop node may not itself be scoped', () => {
    const ir = loopIr();
    ir.nodes = ir.nodes.map((n) => (n.id === 'lp' ? { ...n, scope: { loopId: 'lp' } } : n));
    expect(codes(ir)).toContain('nested_loop_unsupported');
  });

  test('a body with two entries is rejected', () => {
    const ir = loopIr();
    ir.nodes.push({
      id: 'b2',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: {} },
      scope: { loopId: 'lp' },
    });
    ir.edges.push({ id: 'e4', from: { nodeId: 'lp', port: 'item' }, to: { nodeId: 'b2', port: 'input' } });
    expect(codes(ir)).toContain('loop_body_not_single_entry');
  });
});
