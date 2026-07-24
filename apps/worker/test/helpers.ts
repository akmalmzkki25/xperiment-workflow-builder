import { randomUUID } from 'node:crypto';
import { casNode, createExecutionWithTrigger, createVersion, createWorkflow, DEFAULT_WORKSPACE_ID } from '@xperiment/db';
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

export async function seedExecution(
  pool: Pool,
  ir: WorkflowIR,
  payload: unknown = { name: 'Budi', total: 150 },
): Promise<{ workflowId: string; executionId: string }> {
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: ir.workflow.name });
  const version = await createVersion(pool, { workflowId: wf.id, definition: ir, hash: 'test-hash' });
  const { execution } = await createExecutionWithTrigger(pool, {
    workflowId: wf.id,
    versionId: version.id,
    idempotencyKey: `seed-${randomUUID()}`,
    payload,
    nodeIds: ir.nodes.map((n) => n.id),
    executionTimeoutMs: 900000,
  });
  return { workflowId: wf.id, executionId: execution.id };
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
}

export async function queueNode(pool: Pool, executionId: string, nodeId: string): Promise<void> {
  await casNode(pool, { executionId, nodeId, attempt: 1, from: ['PENDING'], to: 'READY' });
  await casNode(pool, { executionId, nodeId, attempt: 1, from: ['READY'], to: 'QUEUED' });
}
