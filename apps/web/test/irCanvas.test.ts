import { describe, expect, test } from 'vitest';
import {
  canvasToDefinition,
  definitionToCanvas,
  edgeId,
  makeNode,
  nextNodeId,
  type EditorNode,
} from '../src/lib/irCanvas';

const CONNECTION_REF = '3f2a4b6c-1d2e-4f5a-8b9c-0d1e2f3a4b5c';

const definition = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_lead', name: 'Lead check' },
  entrypoints: ['hook'],
  nodes: [
    {
      id: 'hook',
      kind: 'trigger',
      type: 'webhook.trigger',
      operationVersion: '0.1.0',
      parameters: { authMode: 'none' },
    },
    {
      id: 'branch',
      kind: 'logic',
      type: 'core.if',
      operationVersion: '0.1.0',
      parameters: { condition: '{{ trigger.body.score }}' },
    },
    {
      id: 'notify',
      kind: 'action',
      type: 'telegram.sendMessage',
      operationVersion: '0.1.0',
      parameters: { chatId: '1', text: 'hi' },
      connectionRef: CONNECTION_REF,
    },
  ],
  edges: [
    { id: 'e_hook_main_branch', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'branch', port: 'input' } },
    { id: 'e_branch_true_notify', from: { nodeId: 'branch', port: 'true' }, to: { nodeId: 'notify', port: 'input' } },
  ],
  metadata: {
    executionTimeoutMs: 60000,
    layout: { hook: { x: 100, y: 80 }, branch: { x: 420, y: 80 } },
  },
};

describe('definitionToCanvas', () => {
  test('maps nodes with layout positions and column fallback', () => {
    const { nodes, edges } = definitionToCanvas(definition);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]!.position).toEqual({ x: 100, y: 80 });
    expect(nodes[1]!.position).toEqual({ x: 420, y: 80 });
    expect(nodes[2]!.position).toEqual({ x: 120 + 2 * 320, y: 160 }); // no layout entry
    expect(nodes[2]!.data.ir.connectionRef).toBe(CONNECTION_REF);
    expect(edges[1]).toEqual({
      id: 'e_branch_true_notify',
      source: 'branch',
      sourceHandle: 'true',
      target: 'notify',
      targetHandle: 'input',
    });
  });

  test('returns an empty canvas for a fresh {} draft or garbage', () => {
    expect(definitionToCanvas({})).toEqual({ nodes: [], edges: [] });
    expect(definitionToCanvas(null)).toEqual({ nodes: [], edges: [] });
    expect(definitionToCanvas('nope')).toEqual({ nodes: [], edges: [] });
  });
});

describe('canvasToDefinition', () => {
  test('round-trips a full definition, adding layout for every node', () => {
    const { nodes, edges } = definitionToCanvas(definition);
    const out = canvasToDefinition({
      workflowId: 'wf_lead',
      name: 'Lead check',
      nodes,
      edges,
      previous: definition,
    }) as typeof definition;
    expect(out.schemaVersion).toBe('0.1');
    expect(out.workflow).toEqual({ id: 'wf_lead', name: 'Lead check' });
    expect(out.entrypoints).toEqual(['hook']);
    expect(out.nodes).toEqual(definition.nodes);
    expect(out.edges).toEqual(definition.edges);
    expect(out.metadata.executionTimeoutMs).toBe(60000);
    expect(out.metadata.layout).toEqual({
      hook: { x: 100, y: 80 },
      branch: { x: 420, y: 80 },
      notify: { x: 760, y: 160 },
    });
  });

  test('returns {} for an empty canvas', () => {
    expect(canvasToDefinition({ workflowId: 'w', name: 'n', nodes: [], edges: [] })).toEqual({});
  });

  test('derives entrypoints from trigger-kind nodes and rounds positions', () => {
    const { nodes, edges } = definitionToCanvas(definition);
    const moved = nodes.map((n): EditorNode => ({ ...n, position: { x: n.position.x + 0.4, y: n.position.y } }));
    const out = canvasToDefinition({ workflowId: 'w', name: 'n', nodes: moved, edges }) as {
      entrypoints: string[];
      metadata: { layout: Record<string, { x: number }> };
    };
    expect(out.entrypoints).toEqual(['hook']);
    expect(out.metadata.layout['hook']!.x).toBe(100);
  });
});

describe('helpers', () => {
  test('nextNodeId appends numeric suffixes to avoid collisions', () => {
    expect(nextNodeId([], 'http_request')).toBe('http_request');
    expect(nextNodeId(['http_request'], 'http_request')).toBe('http_request_2');
    expect(nextNodeId(['http_request', 'http_request_2'], 'http_request')).toBe('http_request_3');
  });

  test('edgeId builds a stable IR-safe id', () => {
    expect(edgeId('a', 'main', 'b')).toBe('e_a_main_b');
  });

  test('makeNode builds an EditorNode from a catalog item with defaults', () => {
    const node = makeNode(
      {
        type: 'core.transform',
        kind: 'logic',
        operationVersion: '0.1.0',
        defaultEffectClass: 'pure',
        outputPorts: ['main'],
        paramsJsonSchema: {},
      },
      'transform_1',
      { x: 10, y: 20 },
      { fields: {} },
    );
    expect(node).toEqual({
      id: 'transform_1',
      type: 'xperiment',
      position: { x: 10, y: 20 },
      data: {
        ir: {
          id: 'transform_1',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: { fields: {} },
        },
      },
    });
  });
});
