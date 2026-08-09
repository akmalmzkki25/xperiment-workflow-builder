import { describe, expect, test } from 'vitest';
import { copySelection, pasteCanvas } from '../src/lib/clipboard';
import { edgeId, type EditorEdge, type EditorNode } from '../src/lib/irCanvas';

function node(id: string, opts: { loop?: boolean; parent?: string; x?: number; y?: number } = {}): EditorNode {
  return {
    id,
    type: opts.loop ? 'xperimentLoop' : 'xperiment',
    position: { x: opts.x ?? 0, y: opts.y ?? 0 },
    data: {
      ir: {
        id,
        kind: 'action',
        type: opts.loop ? 'core.loop' : 'core.transform',
        operationVersion: '0.1.0',
        parameters: {},
        ...(opts.parent ? { scope: { loopId: opts.parent } } : {}),
      },
    },
    ...(opts.parent ? { parentNode: opts.parent, extent: 'parent' as const } : {}),
  };
}

function edge(source: string, target: string, port = 'main'): EditorEdge {
  return { id: edgeId(source, port, target), source, sourceHandle: port, target, targetHandle: 'input' };
}

describe('copySelection', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const edges = [edge('a', 'b'), edge('b', 'c')];

  test('keeps an edge only when both endpoints were copied', () => {
    const clip = copySelection(nodes, edges, ['a', 'b']);
    expect(clip.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(clip.edges).toHaveLength(1);
    expect(clip.edges[0]!.source).toBe('a');
  });

  test('a single node carries no edges at all', () => {
    expect(copySelection(nodes, edges, ['b']).edges).toHaveLength(0);
  });

  test('an empty selection produces an empty clip', () => {
    const clip = copySelection(nodes, edges, []);
    expect(clip.nodes).toHaveLength(0);
    expect(clip.edges).toHaveLength(0);
  });

  test('ignores a selected id that is not on the canvas', () => {
    expect(copySelection(nodes, edges, ['a', 'ghost']).nodes.map((n) => n.id)).toEqual(['a']);
  });

  test('copying a loop container brings its body nodes along', () => {
    // Pasting an empty frame was never what anyone meant by copying a loop.
    const withLoop = [node('loop', { loop: true }), node('inner', { parent: 'loop' }), node('outside')];
    const clip = copySelection(withLoop, [], ['loop']);
    expect(clip.nodes.map((n) => n.id).sort()).toEqual(['inner', 'loop']);
  });

  test('follows nested containers all the way down', () => {
    const nested = [
      node('outer', { loop: true }),
      node('inner', { loop: true, parent: 'outer' }),
      node('leaf', { parent: 'inner' }),
    ];
    expect(copySelection(nested, [], ['outer']).nodes.map((n) => n.id).sort()).toEqual(['inner', 'leaf', 'outer']);
  });

  test('preserves canvas order rather than selection order', () => {
    expect(copySelection(nodes, edges, ['c', 'a']).nodes.map((n) => n.id)).toEqual(['a', 'c']);
  });
});

describe('pasteCanvas', () => {
  const OFFSET = { x: 40, y: 40 };

  test('gives every pasted node a fresh id and keeps ir.id in step', () => {
    const clip = copySelection([node('a')], [], ['a']);
    const out = pasteCanvas(clip, ['a'], OFFSET);
    expect(out.nodes[0]!.id).not.toBe('a');
    expect(out.nodes[0]!.data.ir.id).toBe(out.nodes[0]!.id);
  });

  test('never collides two pasted nodes with each other', () => {
    // Copy 'a' and 'a_2', delete 'a_2', then paste. 'a' wants the now-free 'a_2', and
    // so does 'a_2' itself — both land on 'a_2' unless each minted id is reserved as
    // the map is built. The edge between them would then be a self-loop.
    const clip = { nodes: [node('a'), node('a_2')], edges: [edge('a', 'a_2')] };
    const out = pasteCanvas(clip, ['a'], OFFSET);
    const ids = out.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(out.edges[0]!.source).not.toBe(out.edges[0]!.target);
  });

  test('does not reuse an id already on the canvas', () => {
    const clip = { nodes: [node('a'), node('a_2')], edges: [] };
    const ids = pasteCanvas(clip, ['a', 'a_2'], OFFSET).nodes.map((n) => n.id);
    expect(ids).not.toContain('a');
    expect(ids).not.toContain('a_2');
    expect(new Set(ids).size).toBe(2);
  });

  test('rewrites both endpoints of an internal edge in one pass', () => {
    const clip = copySelection([node('a'), node('b')], [edge('a', 'b')], ['a', 'b']);
    const out = pasteCanvas(clip, ['a', 'b'], OFFSET);
    const [na, nb] = out.nodes as [EditorNode, EditorNode];
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]!.source).toBe(na.id);
    expect(out.edges[0]!.target).toBe(nb.id);
    expect(out.edges[0]!.id).toBe(edgeId(na.id, 'main', nb.id));
  });

  test('carries the source port so a pasted error branch stays an error branch', () => {
    const clip = copySelection([node('a'), node('b')], [edge('a', 'b', 'error')], ['a', 'b']);
    const out = pasteCanvas(clip, ['a', 'b'], OFFSET);
    expect(out.edges[0]!.sourceHandle).toBe('error');
  });

  test('remaps parentNode when the container came along', () => {
    const clip = copySelection([node('loop', { loop: true }), node('inner', { parent: 'loop' })], [], ['loop']);
    const out = pasteCanvas(clip, ['loop', 'inner'], OFFSET);
    const loop = out.nodes.find((n) => n.type === 'xperimentLoop')!;
    const inner = out.nodes.find((n) => n.type !== 'xperimentLoop')!;
    expect(inner.parentNode).toBe(loop.id);
    expect(inner.data.ir.scope).toEqual({ loopId: loop.id });
  });

  test('drops parentNode when the container was not copied', () => {
    // canvasToDefinition derives scope.loopId from parentNode, so a dangling parent
    // would be written into the saved IR as membership of someone else's loop.
    const clip = { nodes: [node('inner', { parent: 'loop' })], edges: [] };
    const out = pasteCanvas(clip, ['loop', 'inner'], OFFSET);
    expect(out.nodes[0]!.parentNode).toBeUndefined();
    expect(out.nodes[0]!.extent).toBeUndefined();
    expect(out.nodes[0]!.data.ir.scope).toBeUndefined();
  });

  test('offsets top-level nodes but leaves container-relative children alone', () => {
    const clip = copySelection(
      [node('loop', { loop: true, x: 100, y: 100 }), node('inner', { parent: 'loop', x: 20, y: 30 })],
      [],
      ['loop'],
    );
    const out = pasteCanvas(clip, ['loop', 'inner'], OFFSET);
    const loop = out.nodes.find((n) => n.type === 'xperimentLoop')!;
    const inner = out.nodes.find((n) => n.type !== 'xperimentLoop')!;
    expect(loop.position).toEqual({ x: 140, y: 140 });
    // Shifting this too would push the body out of the frame it is drawn inside.
    expect(inner.position).toEqual({ x: 20, y: 30 });
  });

  test('pasting the same clip twice produces two independent id sets', () => {
    const clip = copySelection([node('a'), node('b')], [edge('a', 'b')], ['a', 'b']);
    const first = pasteCanvas(clip, ['a', 'b'], OFFSET);
    const existing = ['a', 'b', ...first.nodes.map((n) => n.id)];
    const second = pasteCanvas(clip, existing, OFFSET);
    const firstIds = first.nodes.map((n) => n.id);
    const secondIds = second.nodes.map((n) => n.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(second.edges[0]!.id).not.toBe(first.edges[0]!.id);
  });

  test('leaves the clip untouched so it can be pasted again', () => {
    const clip = copySelection([node('a', { x: 5, y: 5 })], [], ['a']);
    const before = JSON.stringify(clip);
    pasteCanvas(clip, ['a'], OFFSET);
    pasteCanvas(clip, ['a'], OFFSET);
    expect(JSON.stringify(clip)).toBe(before);
  });

  test('an empty clip pastes nothing', () => {
    const out = pasteCanvas({ nodes: [], edges: [] }, ['a'], OFFSET);
    expect(out.nodes).toHaveLength(0);
    expect(out.edges).toHaveLength(0);
  });
});
