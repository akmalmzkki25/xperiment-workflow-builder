import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { validateWorkflow, type RegistryLike } from '../src/index.js';

const registry: RegistryLike = {
  get(type: string) {
    if (type === 'manual.trigger')
      return {
        kind: 'trigger',
        paramsSchema: z.object({}).strict(),
        defaultEffectClass: 'pure',
        outputPorts: ['main'],
      };
    if (type === 'db.read')
      return {
        kind: 'action',
        paramsSchema: z.object({}).strict(),
        defaultEffectClass: 'read',
        outputPorts: ['main'],
        requiresConnection: 'postgres',
      };
    return undefined;
  },
};

const CONN = '11111111-1111-1111-1111-111111111111';

function ir(connectionRef?: string) {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'w', name: 'w' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'q',
        kind: 'action',
        type: 'db.read',
        operationVersion: '0.1.0',
        parameters: {},
        ...(connectionRef ? { connectionRef } : {}),
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'q', port: 'input' } }],
  };
}

describe('connection validation layer', () => {
  const connections = [{ id: CONN, connectorKey: 'postgres' }];

  test('missing connectionRef on a requiring node', () => {
    const r = validateWorkflow(ir(), { registry, connections });
    expect(
      r.findings.some((f) => f.layer === 'connections' && f.code === 'connection_required' && f.nodeId === 'q'),
    ).toBe(true);
  });

  test('unknown and wrong-type refs', () => {
    const unknown = validateWorkflow(ir('22222222-2222-2222-2222-222222222222'), { registry, connections });
    expect(unknown.findings.some((f) => f.code === 'connection_not_found')).toBe(true);
    const wrong = validateWorkflow(ir(CONN), { registry, connections: [{ id: CONN, connectorKey: 'telegram' }] });
    expect(wrong.findings.some((f) => f.code === 'connection_wrong_type')).toBe(true);
  });

  test('valid ref passes; layer skipped without connections opt', () => {
    expect(validateWorkflow(ir(CONN), { registry, connections }).valid).toBe(true);
    expect(validateWorkflow(ir(), { registry }).valid).toBe(true);
  });
});
