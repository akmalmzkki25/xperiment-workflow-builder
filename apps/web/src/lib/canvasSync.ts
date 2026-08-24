/**
 * Whether an agent's saved draft may replace what is on the canvas.
 *
 * This function decides whether somebody loses work, which is why it is its own file with
 * its own tests rather than three lines inside a component.
 *
 * The new problem the agent creates: the SERVER advanced the draft revision without the
 * browser doing a PUT. Left alone, the editor's revision goes stale and the next Ctrl+S
 * returns 412 with a "this draft changed in another session" banner — which is exactly
 * wrong, because the change was the one they asked for.
 */
export type CanvasSyncDecision =
  | { action: 'apply'; revision: number }
  | { action: 'offer'; revision: number }
  | { action: 'ignore'; reason: 'stale' | 'other-workflow' };

export function decideCanvasSync(
  frame: { workflowId: string; revision: number },
  local: { workflowId: string; revision: number | null; dirty: boolean },
): CanvasSyncDecision {
  // The person navigated to another workflow while the turn was still running.
  if (frame.workflowId !== local.workflowId) return { action: 'ignore', reason: 'other-workflow' };

  // A replayed or out-of-order frame after a resume. Applying it would walk the canvas
  // backwards.
  if (local.revision !== null && frame.revision <= local.revision) return { action: 'ignore', reason: 'stale' };

  // Unsaved work on the canvas is never silently replaced. Offering costs one click;
  // clobbering costs whatever they had just built.
  if (local.dirty) return { action: 'offer', revision: frame.revision };

  return { action: 'apply', revision: frame.revision };
}
