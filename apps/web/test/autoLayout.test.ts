import { describe, expect, test } from 'vitest';
import { autoLayout, type LayoutEdge, type LayoutNode } from '../src/lib/autoLayout';

const n = (id: string, parent?: string, isContainer = false): LayoutNode => ({
  id,
  isContainer,
  ...(parent ? { parentNode: parent } : {}),
});

const e = (source: string, target: string): LayoutEdge => ({ source, target });

/** x of a node, for readability in assertions. */
const xs = (r: ReturnType<typeof autoLayout>, id: string) => r.positions.get(id)!.x;
const ys = (r: ReturnType<typeof autoLayout>, id: string) => r.positions.get(id)!.y;

describe('autoLayout', () => {
  test('a chain marches left to right in one row', () => {
    const r = autoLayout([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')]);
    expect(xs(r, 'a')).toBeLessThan(xs(r, 'b'));
    expect(xs(r, 'b')).toBeLessThan(xs(r, 'c'));
    expect(ys(r, 'a')).toBe(ys(r, 'b'));
  });

  test('a diamond puts both branches in the same layer and different rows', () => {
    const r = autoLayout(
      [n('a'), n('left'), n('right'), n('join')],
      [e('a', 'left'), e('a', 'right'), e('left', 'join'), e('right', 'join')],
    );
    expect(xs(r, 'left')).toBe(xs(r, 'right'));
    expect(ys(r, 'left')).not.toBe(ys(r, 'right'));
    expect(xs(r, 'join')).toBeGreaterThan(xs(r, 'left'));
  });

  test('layering is longest-path, so a join sits past its deepest input', () => {
    // a -> b -> c -> join, and a -> join directly. join must land after c, not beside b.
    const r = autoLayout(
      [n('a'), n('b'), n('c'), n('join')],
      [e('a', 'b'), e('b', 'c'), e('c', 'join'), e('a', 'join')],
    );
    expect(xs(r, 'join')).toBeGreaterThan(xs(r, 'c'));
  });

  test('the result does not depend on the input array order', () => {
    const nodes = [n('a'), n('left'), n('right'), n('join')];
    const edges = [e('a', 'left'), e('a', 'right'), e('left', 'join'), e('right', 'join')];
    const forward = autoLayout(nodes, edges);
    const reversed = autoLayout([...nodes].reverse(), [...edges].reverse());
    for (const id of ['a', 'left', 'right', 'join']) {
      expect(reversed.positions.get(id)).toEqual(forward.positions.get(id));
    }
  });

  test('unconnected nodes also land in the same place whatever the array order', () => {
    // The case that actually leaks: a node with no neighbour in the reference layer has
    // no barycenter, so it holds its seeded position. A diamond hides this, because
    // both branches tie and the id tie-break rescues the result either way.
    const forward = autoLayout([n('a'), n('b'), n('c')], []);
    const reversed = autoLayout([n('c'), n('b'), n('a')], []);
    for (const id of ['a', 'b', 'c']) {
      expect(reversed.positions.get(id)).toEqual(forward.positions.get(id));
    }
  });

  test('a cycle lays out instead of hanging', () => {
    // The canvas can hold an invalid draft; layout must never be the thing that breaks.
    const r = autoLayout([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c'), e('c', 'a')]);
    expect(r.positions.size).toBe(3);
    for (const id of ['a', 'b', 'c']) {
      expect(Number.isFinite(xs(r, id))).toBe(true);
      expect(Number.isFinite(ys(r, id))).toBe(true);
    }
  });

  test('a node with no edges at all is still placed', () => {
    const r = autoLayout([n('lonely')], []);
    expect(r.positions.get('lonely')).toBeDefined();
  });

  test('every position is at or past the origin', () => {
    const r = autoLayout(
      [n('a'), n('b'), n('c'), n('d')],
      [e('a', 'b'), e('a', 'c'), e('a', 'd')],
    );
    for (const p of r.positions.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  test('an edge to a node that is not on the canvas is ignored', () => {
    const r = autoLayout([n('a'), n('b')], [e('a', 'b'), e('a', 'ghost'), e('ghost', 'b')]);
    expect(r.positions.size).toBe(2);
    expect(xs(r, 'a')).toBeLessThan(xs(r, 'b'));
  });
});

describe('loop containers', () => {
  test('body nodes are laid out inside the container in container-relative coordinates', () => {
    const r = autoLayout(
      [n('loop', undefined, true), n('one', 'loop'), n('two', 'loop')],
      [e('one', 'two')],
    );
    // Relative to the frame, so both start near its own origin rather than the canvas'.
    expect(xs(r, 'one')).toBeLessThan(xs(r, 'two'));
    expect(xs(r, 'one')).toBeLessThan(xs(r, 'loop') + 200);
    expect(r.sizes.get('loop')).toBeDefined();
  });

  test('the container is sized to hold its body', () => {
    const one = autoLayout([n('loop', undefined, true), n('a', 'loop')], []);
    const three = autoLayout(
      [n('loop', undefined, true), n('a', 'loop'), n('b', 'loop'), n('c', 'loop')],
      [e('a', 'b'), e('b', 'c')],
    );
    expect(three.sizes.get('loop')!.width).toBeGreaterThan(one.sizes.get('loop')!.width);
  });

  test('the column after a loop container starts past the frame', () => {
    // The next column must clear the FRAME, not a 264px node box.
    const r = autoLayout(
      [n('loop', undefined, true), n('a', 'loop'), n('b', 'loop'), n('c', 'loop'), n('after')],
      [e('a', 'b'), e('b', 'c'), e('loop', 'after')],
    );
    const frame = r.sizes.get('loop')!;
    expect(xs(r, 'after')).toBeGreaterThanOrEqual(xs(r, 'loop') + frame.width);
  });

  test('an edge crossing the container boundary does not layer the body', () => {
    // loop --item--> body is a real edge on the canvas but spans two groups.
    const r = autoLayout(
      [n('loop', undefined, true), n('body', 'loop'), n('after')],
      [e('loop', 'body'), e('loop', 'after')],
    );
    expect(r.positions.get('body')).toBeDefined();
    expect(xs(r, 'after')).toBeGreaterThan(xs(r, 'loop'));
  });

  test('nested containers are sized innermost first', () => {
    const r = autoLayout(
      [
        n('outer', undefined, true),
        n('inner', 'outer', true),
        n('leaf1', 'inner'),
        n('leaf2', 'inner'),
      ],
      [e('leaf1', 'leaf2')],
    );
    const inner = r.sizes.get('inner')!;
    const outer = r.sizes.get('outer')!;
    expect(inner.width).toBeGreaterThan(0);
    // The outer frame must be wide enough to hold the inner one it contains.
    expect(outer.width).toBeGreaterThanOrEqual(inner.width);
  });

  test('a parentNode cycle demotes its members instead of recursing forever', () => {
    const r = autoLayout(
      [
        { id: 'x', isContainer: true, parentNode: 'y' },
        { id: 'y', isContainer: true, parentNode: 'x' },
        n('safe'),
      ],
      [],
    );
    expect(r.positions.size).toBe(3);
    expect(Number.isFinite(xs(r, 'x'))).toBe(true);
    expect(Number.isFinite(xs(r, 'y'))).toBe(true);
  });

  test('a parentNode pointing at a missing node is treated as top level', () => {
    const r = autoLayout([n('orphan', 'gone')], []);
    expect(r.positions.get('orphan')).toBeDefined();
  });
});
