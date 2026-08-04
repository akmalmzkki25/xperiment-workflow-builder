import { randomUUID } from 'node:crypto';
import { createExecutionWithTrigger, createVersion, createWorkflow, DEFAULT_WORKSPACE_ID } from '@xperiment/db';
import type { WorkflowIR } from '@xperiment/ir';
import type { Pool } from 'pg';

export type { WorkflowIR } from '@xperiment/ir';

export function linearIr(): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_lin', name: 'Linear' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'greet',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { msg: 'Halo {{ trigger.body.name }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'greet', port: 'input' } }],
  };
}

export function branchIr(): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_br', name: 'Branch' },
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

/** t → a → b, with a → h on the error port. `a` is the node the tests fail. */
export function errorPathIr(): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_err', name: 'Error path' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      { id: 'a', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: {} } },
      { id: 'b', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: {} } },
      { id: 'h', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: {} } },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'a', port: 'input' } },
      { id: 'e2', from: { nodeId: 'a', port: 'main' }, to: { nodeId: 'b', port: 'input' } },
      { id: 'e3', from: { nodeId: 'a', port: 'error' }, to: { nodeId: 'h', port: 'input' } },
    ],
  };
}

export async function seedExecution(
  pool: Pool,
  ir: WorkflowIR,
  payload: unknown = { name: 'Budi', total: 150 },
): Promise<{ workflowId: string; executionId: string }> {
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: ir.workflow.name });
  const version = await createVersion(pool, { workflowId: wf.id, definition: ir, hash: 'test-hash' });
  const result = await createExecutionWithTrigger(pool, {
    workflowId: wf.id,
    versionId: version.id,
    idempotencyKey: `seed-${randomUUID()}`,
    payload,
    nodeIds: ir.nodes.map((n) => n.id),
    executionTimeoutMs: 900000,
  });
  if (result.outcome === 'quota_exceeded') throw new Error('seedExecution hit a quota refusal');
  return { workflowId: wf.id, executionId: result.execution.id };
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE usage_events, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
}
