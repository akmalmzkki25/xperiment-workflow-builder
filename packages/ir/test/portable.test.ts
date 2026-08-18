import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { buildExport, EXPORT_FORMAT, planImport, requiredConnections } from '../src/portable.js';
import type { NodeKind, RegistryLike } from '../src/index.js';
import type { WorkflowIR } from '../src/types.js';

const registry: RegistryLike = {
  get(type: string) {
    const table: Record<string, { kind: NodeKind; requiresConnection?: string }> = {
      'webhook.trigger': { kind: 'trigger' },
      'core.transform': { kind: 'logic' },
      'telegram.sendMessage': { kind: 'action', requiresConnection: 'telegram' },
      'openai.chat': { kind: 'action', requiresConnection: 'openai' },
    };
    const info = table[type];
    if (!info) return undefined;
    return {
      kind: info.kind,
      paramsSchema: z.object({}).strict(),
      defaultEffectClass: 'pure' as const,
      outputPorts: ['main'],
      ...(info.requiresConnection ? { requiresConnection: info.requiresConnection } : {}),
    };
  },
};

const TG = '11111111-1111-1111-1111-111111111111';
const OAI = '22222222-2222-2222-2222-222222222222';

function ir(nodes: WorkflowIR['nodes']): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf', name: 'Portable' },
    entrypoints: ['hook'],
    nodes,
    edges: [],
    metadata: { layout: { hook: { x: 10, y: 20 } } },
  } as WorkflowIR;
}

const hook = { id: 'hook', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: {} };
const notify = {
  id: 'notify',
  kind: 'action',
  type: 'telegram.sendMessage',
  operationVersion: '0.1.0',
  parameters: {},
  connectionRef: TG,
};

describe('requiredConnections', () => {
  test('names the connector each node needs, in words rather than a UUID', () => {
    const out = requiredConnections(ir([hook, notify] as WorkflowIR['nodes']), registry);
    expect(out).toEqual([{ nodeId: 'notify', connectorKey: 'telegram', wasConnected: true }]);
  });

  test('reports a node that needs one but never had it', () => {
    const bare = { ...notify };
    delete (bare as { connectionRef?: string }).connectionRef;
    const out = requiredConnections(ir([hook, bare] as WorkflowIR['nodes']), registry);
    expect(out[0]!.wasConnected).toBe(false);
  });

  test('is derived from the registry, so a node needing nothing is not listed', () => {
    const plain = { id: 't', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {} };
    expect(requiredConnections(ir([hook, plain] as WorkflowIR['nodes']), registry)).toEqual([]);
  });
});

describe('buildExport', () => {
  test('carries the layout, so the canvas survives the round trip', () => {
    // An import that stacked every node at the origin would be technically complete and
    // practically useless.
    const doc = buildExport('Pesanan baru', ir([hook, notify] as WorkflowIR['nodes']), registry);
    expect(doc.definition.metadata?.layout).toEqual({ hook: { x: 10, y: 20 } });
    expect(doc.xperimentExport).toBe(EXPORT_FORMAT);
    expect(doc.name).toBe('Pesanan baru');
  });

  test('the manifest is what makes a foreign import actionable', () => {
    const doc = buildExport('X', ir([hook, notify] as WorkflowIR['nodes']), registry);
    expect(doc.requiredConnections).toEqual([{ nodeId: 'notify', connectorKey: 'telegram', wasConnected: true }]);
  });
});

const HERE = { id: 'wf-new', name: 'Salinan' };

function plan(nodes: unknown[], connections: { id: string; connectorKey: string }[] = []) {
  return planImport({ ir: ir(nodes as WorkflowIR['nodes']), registry, connections, identity: HERE });
}

describe('planImport', () => {
  test('keeps a reference that resolves here, which makes a same-workspace import a true duplicate', () => {
    const p = plan([hook, notify], [{ id: TG, connectorKey: 'telegram' }]);
    expect(p.reconnect).toEqual([]);
    expect((p.definition.nodes[1] as { connectionRef?: string }).connectionRef).toBe(TG);
  });

  test('strips a reference that does not exist here, and says which node needs what', () => {
    // Left dangling, it would fail validation later as connection_not_found on a node
    // nobody was told about. Stripped, it fails as connection_required on exactly the
    // node this function already named — so the two agree.
    const p = plan([hook, notify]);
    expect(p.reconnect).toEqual([{ nodeId: 'notify', connectorKey: 'telegram', wasConnected: true }]);
    expect((p.definition.nodes[1] as { connectionRef?: string }).connectionRef).toBeUndefined();
  });

  test('a connection of the WRONG connector does not count as resolving', () => {
    // A telegram node must not silently adopt an openai credential that happens to share
    // the imported UUID.
    const p = plan([hook, notify], [{ id: TG, connectorKey: 'openai' }]);
    expect(p.reconnect.map((r) => r.nodeId)).toEqual(['notify']);
    expect((p.definition.nodes[1] as { connectionRef?: string }).connectionRef).toBeUndefined();
  });

  test('a node that needs no connection never keeps a stray reference', () => {
    const strays = [
      hook,
      { id: 't', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {}, connectionRef: TG },
    ];
    const p = plan(strays, [{ id: TG, connectorKey: 'telegram' }]);
    expect((p.definition.nodes[1] as { connectionRef?: string }).connectionRef).toBeUndefined();
    expect(p.reconnect).toEqual([]);
  });

  test('reports every unresolvable node, not just the first', () => {
    const chat = {
      id: 'chat',
      kind: 'action',
      type: 'openai.chat',
      operationVersion: '0.1.0',
      parameters: {},
      connectionRef: OAI,
    };
    const p = plan([hook, notify, chat]);
    expect(p.reconnect.map((r) => r.connectorKey).sort()).toEqual(['openai', 'telegram']);
  });

  test('never mutates the definition it was given', () => {
    const original = ir([hook, notify] as WorkflowIR['nodes']);
    planImport({ ir: original, registry, connections: [], identity: HERE });
    expect((original.nodes[1] as { connectionRef?: string }).connectionRef).toBe(TG);
    expect(original.workflow.id).toBe('wf');
  });

  test('a mixed import keeps what resolves and strips what does not', () => {
    const chat = {
      id: 'chat',
      kind: 'action',
      type: 'openai.chat',
      operationVersion: '0.1.0',
      parameters: {},
      connectionRef: OAI,
    };
    const p = plan([hook, notify, chat], [{ id: TG, connectorKey: 'telegram' }]);
    expect(p.reconnect.map((r) => r.nodeId)).toEqual(['chat']);
    expect((p.definition.nodes[1] as { connectionRef?: string }).connectionRef).toBe(TG);
    expect((p.definition.nodes[2] as { connectionRef?: string }).connectionRef).toBeUndefined();
  });

  test('the definition claims the row it is about to belong to, not the one it came from', () => {
    // Left alone, the stored draft would keep the source workflow's id until somebody
    // happened to press Save — which rewrites it — so the wrongness would be invisible
    // and intermittent.
    const p = plan([hook, notify]);
    expect(p.definition.workflow).toEqual({ id: 'wf-new', name: 'Salinan' });
  });
});
