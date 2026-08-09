/**
 * A bounded undo stack over canvas snapshots.
 *
 * The present state is NOT stored here — React Flow owns it. Callers pass the current
 * value in on undo/redo and get the neighbouring one back, which keeps this file free
 * of any canvas types and makes it testable without a DOM.
 */

/** Deep enough to cover a work session, shallow enough that snapshots cost nothing. */
export const MAX_HISTORY = 50;

export interface History<T> {
  readonly past: readonly T[];
  readonly future: readonly T[];
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

/**
 * Record the state as it was just before an edit.
 *
 * Clears the redo branch: once you edit from a rewound point, the states you had
 * rewound past are unreachable, and offering Redo for them would restore a canvas
 * the new edit was never applied to.
 */
export function pushSnapshot<T>(h: History<T>, snapshot: T): History<T> {
  const past = [...h.past, snapshot];
  return { past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past, future: [] };
}

export function undo<T>(h: History<T>, current: T): { history: History<T>; restored: T } | null {
  if (h.past.length === 0) return null;
  const restored = h.past[h.past.length - 1] as T;
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future] }, restored };
}

export function redo<T>(h: History<T>, current: T): { history: History<T>; restored: T } | null {
  if (h.future.length === 0) return null;
  const restored = h.future[0] as T;
  return { history: { past: [...h.past, current], future: h.future.slice(1) }, restored };
}

/** The shape of a React Flow NodeChange this module cares about. */
interface ChangeLike {
  type: string;
  dragging?: boolean | null;
}

export interface ChangeVerdict {
  /** Snapshot the canvas before applying these changes. */
  push: boolean;
  /** The drag-gesture flag the caller should hold until the next call. */
  gesture: boolean;
}

/**
 * Whether a batch of node changes is worth one history entry.
 *
 * React Flow emits a `position` change per pointer frame, so a single drag across the
 * canvas is dozens of changes. Recording each would evict the entire stack in one
 * gesture; recording none would make moving a node unundoable. The gesture flag turns
 * the run into exactly one entry, taken before the first frame moved anything.
 */
export function nodeChangeVerdict(changes: readonly ChangeLike[], gesture: boolean): ChangeVerdict {
  const discrete = changes.some((c) => c.type === 'remove' || c.type === 'add');
  const dragging = changes.some((c) => c.type === 'position' && c.dragging === true);
  const dragEnded = changes.some((c) => c.type === 'position' && c.dragging === false);

  if (discrete) return { push: true, gesture: dragging ? gesture : false };
  if (dragging) return { push: !gesture, gesture: true };
  if (dragEnded) return { push: false, gesture: false };
  // `dimensions` fires once per node at mount and `select` on every click. Either
  // would flood the stack. A position change with no `dragging` flag is programmatic
  // — whoever moved the nodes pushes its own snapshot.
  return { push: false, gesture };
}
