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
}
