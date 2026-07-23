import { getExecutionDetail, getVersion, type ExecutionRow } from '@xperiment/db';
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

export const TERMINAL_EXECUTION_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT'];
