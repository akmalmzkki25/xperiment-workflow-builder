import { describe, expect, test } from 'vitest';
import {
  MAX_HISTORY,
  canRedo,
  canUndo,
  emptyHistory,
  nodeChangeVerdict,
  pushSnapshot,
  redo,
  undo,
} from '../src/lib/history';

interface Snap {
  n: number;
}

const snap = (n: number): Snap => ({ n });

describe('the undo stack', () => {
  test('starts empty and offers nothing', () => {
    const h = emptyHistory<Snap>();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h, snap(1))).toBeNull();
    expect(redo(h, snap(1))).toBeNull();
  });

  test('undo restores the pushed snapshot and offers the current one back', () => {
    const h = pushSnapshot(emptyHistory<Snap>(), snap(1));
    const back = undo(h, snap(2));
    expect(back?.restored).toEqual(snap(1));
    expect(canRedo(back!.history)).toBe(true);

    const forward = redo(back!.history, snap(1));
    expect(forward?.restored).toEqual(snap(2));
    expect(canUndo(forward!.history)).toBe(true);
  });

  test('drops the oldest entry past the cap', () => {
    let h = emptyHistory<Snap>();
    for (let i = 0; i < MAX_HISTORY + 10; i += 1) h = pushSnapshot(h, snap(i));
    expect(h.past).toHaveLength(MAX_HISTORY);
    // The oldest survivor is entry 10, not entry 0 — the cap drops from the front.
    expect(h.past[0]).toEqual(snap(10));
    expect(h.past.at(-1)).toEqual(snap(MAX_HISTORY + 9));
  });

  test('a new edit after an undo discards the redo branch', () => {
    const h = pushSnapshot(emptyHistory<Snap>(), snap(1));
    const back = undo(h, snap(2))!;
    expect(canRedo(back.history)).toBe(true);

    const edited = pushSnapshot(back.history, snap(3));
    expect(canRedo(edited)).toBe(false);
    expect(edited.future).toHaveLength(0);
  });

  test('never mutates the history it was given', () => {
    const h = pushSnapshot(emptyHistory<Snap>(), snap(1));
    const before = JSON.stringify(h);
    pushSnapshot(h, snap(2));
    undo(h, snap(9));
    expect(JSON.stringify(h)).toBe(before);
  });

  test('undo and redo walk a multi-step trail in order', () => {
    let h = emptyHistory<Snap>();
    h = pushSnapshot(h, snap(1));
    h = pushSnapshot(h, snap(2));
    const first = undo(h, snap(3))!;
    expect(first.restored).toEqual(snap(2));
    const second = undo(first.history, first.restored)!;
    expect(second.restored).toEqual(snap(1));
    expect(canUndo(second.history)).toBe(false);

    const fwd = redo(second.history, second.restored)!;
    expect(fwd.restored).toEqual(snap(2));
  });
});

describe('which canvas changes deserve a history entry', () => {
  const active = (changes: { type: string; dragging?: boolean }[], gesture = false) =>
    nodeChangeVerdict(changes, gesture);

  test('a discrete add or remove pushes once', () => {
    expect(active([{ type: 'remove' }])).toEqual({ push: true, gesture: false });
    expect(active([{ type: 'add' }])).toEqual({ push: true, gesture: false });
  });

  test('dimensions and select never push', () => {
    // Both fire in floods — dimensions once per node at mount, select on every click.
    // Either would evict the whole undo stack during a single page load.
    expect(active([{ type: 'dimensions' }])).toEqual({ push: false, gesture: false });
    expect(active([{ type: 'select' }])).toEqual({ push: false, gesture: false });
    expect(active([{ type: 'reset' }])).toEqual({ push: false, gesture: false });
  });

  test('a drag pushes exactly one entry however many frames it emits', () => {
    const start = active([{ type: 'position', dragging: true }], false);
    expect(start).toEqual({ push: true, gesture: true });

    // Every later frame of the same gesture is silent.
    for (let i = 0; i < 40; i += 1) {
      expect(active([{ type: 'position', dragging: true }], true)).toEqual({ push: false, gesture: true });
    }

    expect(active([{ type: 'position', dragging: false }], true)).toEqual({ push: false, gesture: false });
  });

  test('a second drag after the first ends pushes again', () => {
    expect(active([{ type: 'position', dragging: true }], false).push).toBe(true);
  });

  test('a remove batched with drag frames still pushes', () => {
    expect(active([{ type: 'position', dragging: true }], true)).toEqual({ push: false, gesture: true });
    expect(active([{ type: 'position', dragging: true }, { type: 'remove' }], true).push).toBe(true);
  });

  test('a programmatic position change is not treated as a drag', () => {
    expect(active([{ type: 'position' }], false)).toEqual({ push: false, gesture: false });
  });

  test('an empty change list does nothing', () => {
    expect(active([], false)).toEqual({ push: false, gesture: false });
    expect(active([], true)).toEqual({ push: false, gesture: true });
  });
});
