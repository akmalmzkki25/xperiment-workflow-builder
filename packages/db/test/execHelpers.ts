import type { CreateExecutionResult, ExecutionRow } from '../src/index.js';

/**
 * Narrow a creation result to its execution for tests that are not about quota.
 * Throws loudly on a refusal so a test never silently asserts against nothing.
 */
export function executionOf(result: CreateExecutionResult): ExecutionRow {
  if (result.outcome === 'quota_exceeded') {
    throw new Error(`unexpected quota refusal: ${result.metric} ${result.used}/${result.limit}`);
  }
  return result.execution;
}
