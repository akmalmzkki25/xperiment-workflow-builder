import type { ExpressionContext } from '@xperiment/expressions';
import { parseInstanceId } from './expand.js';

export interface ContextOptions {
  /** Evaluation instant, epoch ms UTC. Required so the compiler finds every caller. */
  now: number;
  loop?: { index: number; item: unknown };
}

export function buildContext(
  executionId: string,
  triggerBody: unknown,
  outputs: Record<string, unknown>,
  opts: ContextOptions,
): ExpressionContext {
  const { now, loop } = opts;
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
    now,
    ...(loop ? { loop } : {}),
  };
}
