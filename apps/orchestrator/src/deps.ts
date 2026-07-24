import { getExecutionDetail, getVersion, type ExecutionRow, type RecordExecutionUsageArgs } from '@xperiment/db';
import { workflowIrSchema, type WorkflowIR } from '@xperiment/ir';
import type pg from 'pg';

export interface OrchestratorDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export async function loadExecutionContext(
  pool: pg.Pool,
  executionId: string,
): Promise<{ execution: ExecutionRow; ir: WorkflowIR } | null> {
  const detail = await getExecutionDetail(pool, executionId);
  if (!detail) return null;
  const version = await getVersion(pool, detail.execution.workflowVersionId);
  if (!version) return null;
  return { execution: detail.execution, ir: workflowIrSchema.parse(version.definition) as WorkflowIR };
}

export const TERMINAL_EXECUTION_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'];

/**
 * Build the usage-ledger args for a finalized execution. `nodeCount` counts nodes
 * that actually ran (terminal-run states); `computeMs` is the wall-clock duration
 * (0 if the execution never started).
 */
export function buildExecutionUsage(
  execution: ExecutionRow,
  states: { status: string }[],
  status: string,
): RecordExecutionUsageArgs {
  return {
    workspaceId: execution.workspaceId,
    workflowId: execution.workflowId,
    executionId: execution.id,
    status,
    nodeCount: states.filter((s) => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
    computeMs: execution.startedAt ? Date.now() - new Date(execution.startedAt).getTime() : 0,
    occurredAt: new Date(),
  };
}
