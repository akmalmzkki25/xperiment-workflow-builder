import type { ExpressionContext } from '@xperiment/expressions';

export function buildContext(
  executionId: string,
  triggerBody: unknown,
  outputs: Record<string, unknown>,
): ExpressionContext {
  const nodes: Record<string, { output: unknown }> = {};
  for (const [nodeId, output] of Object.entries(outputs)) nodes[nodeId] = { output };
  return { trigger: { body: triggerBody }, nodes, execution: { id: executionId } };
}
