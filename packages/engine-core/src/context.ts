import type { ExpressionContext } from '@xperiment/expressions';
import { parseInstanceId } from './expand.js';

export function buildContext(
  executionId: string,
  triggerBody: unknown,
  outputs: Record<string, unknown>,
  loop?: { index: number; item: unknown },
): ExpressionContext {
  const nodes: Record<string, { output: unknown }> = {};
  for (const [nodeId, output] of Object.entries(outputs)) nodes[nodeId] = { output };
  // Inside iteration i, an expression naming a sibling body node means that iteration's copy.
  // The author cannot know the instance id while editing, so alias it here.
  if (loop) {
    for (const [nodeId, output] of Object.entries(outputs)) {
      const parsed = parseInstanceId(nodeId);
      if (parsed && parsed.iteration === loop.index) nodes[parsed.nodeId] = { output };
    }
  }
  return {
    trigger: { body: triggerBody },
    nodes,
    execution: { id: executionId },
    ...(loop ? { loop } : {}),
  };
}
