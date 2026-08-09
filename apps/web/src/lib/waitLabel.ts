const KIND_LABEL: Record<string, string> = {
  timer: 'Waiting on a timer',
  event: 'Waiting for an event',
  approval: 'Waiting for an approval',
};

/**
 * Why a run is sitting still.
 *
 * Falls back to the raw kind rather than to blank: a wait kind the UI has not learned
 * yet should still say something, because "waiting, reason unknown" is more use to an
 * operator than an empty line.
 */
export function waitKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** How a wait was resolved, or null when it has not been. */
export function waitDecisionLine(decision: string | null, resolvedBy: string | null): string | null {
  if (!decision) return null;
  return resolvedBy ? `Decided ${decision} by ${resolvedBy}` : `Decided ${decision}`;
}
