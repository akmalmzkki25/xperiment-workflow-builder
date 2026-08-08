/**
 * The evaluation context.
 *
 * It lives in its own module so the function library can depend on the type without
 * importing the evaluator — which imports the function library.
 */
export interface ExpressionContext {
  trigger: { body: unknown };
  nodes: Record<string, { output: unknown }>;
  execution: { id: string };
  /** Present only while a loop body node is running. */
  loop?: { index: number; item: unknown };
  /**
   * The evaluation instant, epoch ms UTC. `now()` reads THIS and never Date.now(),
   * so every date in one node's parameter resolution agrees and a test can pin it.
   *
   * A number rather than a Date: resolveTemplate deep-walks this structure and tests
   * compare it with toEqual, and a Date is a mutable object in both of those paths.
   */
  now: number;
}
