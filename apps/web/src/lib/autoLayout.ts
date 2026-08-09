/**
 * Deterministic layered layout for the canvas — the engine behind "Tidy".
 *
 * Pure, dependency-free and free of React and reactflow imports, which is what lets it
 * be unit-tested: apps/web runs vitest in the node environment with no DOM.
 *
 * Determinism is the whole contract. Two runs over the same graph must produce the same
 * coordinates, and the result must not depend on the order nodes happen to sit in the
 * input array — otherwise Tidy would shuffle the canvas every time it was pressed.
 * Every tie is therefore broken by node id, never by array index.
 */

export interface LayoutNode {
  id: string;
  /** A loop container is sized to fit its body rather than to a fixed node box. */
  isContainer: boolean;
  parentNode?: string | undefined;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Horizontal space between one column and the next. */
  colGap: number;
  /** Vertical space between two nodes sharing a column. */
  rowGap: number;
  /** Space between a container's frame and the body it holds. */
  padX: number;
  padY: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 264,
  nodeHeight: 96,
  colGap: 72,
  rowGap: 40,
  padX: 32,
  padY: 56,
};

export interface LayoutResult {
  /** Top-level nodes in canvas coordinates; body nodes relative to their container. */
  positions: Map<string, { x: number; y: number }>;
  /** Frame size for every container, so the caller can apply it as a style. */
  sizes: Map<string, { width: number; height: number }>;
}

interface Size {
  width: number;
  height: number;
}

/**
 * The container each node really belongs to.
 *
 * A `parentNode` naming a node that is not on the canvas, or one that sits in a parent
 * cycle, is demoted to top level. The canvas can hold a broken draft and layout must
 * never be the thing that hangs on it.
 */
function resolveGroups(nodes: readonly LayoutNode[]): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const group = new Map<string, string>();
  for (const node of nodes) {
    let parent = node.parentNode;
    const seen = new Set<string>([node.id]);
    while (parent !== undefined && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = byId.get(parent)?.parentNode;
    }
    const direct = node.parentNode;
    const valid = direct !== undefined && byId.has(direct) && parent === undefined;
    group.set(node.id, valid ? direct : '');
  }
  return group;
}

/** How deeply a container is nested, so the innermost is measured first. */
function containerDepth(id: string, group: Map<string, string>): number {
  let depth = 0;
  let parent = group.get(id) ?? '';
  while (parent !== '' && depth < 64) {
    depth += 1;
    parent = group.get(parent) ?? '';
  }
  return depth;
}

/**
 * Longest-path layering by Kahn's algorithm.
 *
 * Nodes Kahn never emits are in a cycle. They are assigned in id order, one past their
 * deepest already-placed predecessor, which always terminates.
 */
function assignLayers(ids: readonly string[], edges: readonly LayoutEdge[]): Map<string, number> {
  const inSet = new Set(ids);
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  const pred = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const edge of edges) {
    if (!inSet.has(edge.source) || !inSet.has(edge.target) || edge.source === edge.target) continue;
    succ.get(edge.source)!.push(edge.target);
    pred.get(edge.target)!.push(edge.source);
    indeg.set(edge.target, (indeg.get(edge.target) ?? 0) + 1);
  }

  const layer = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  for (const id of queue) layer.set(id, 0);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of succ.get(id)!) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1));
      const remaining = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, remaining);
      // Insert in id order so the traversal itself does not depend on edge order.
      if (remaining === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  for (const id of [...ids].sort()) {
    if (layer.has(id)) continue;
    const placed = pred.get(id)!.filter((p) => layer.has(p));
    layer.set(id, placed.length === 0 ? 0 : Math.max(...placed.map((p) => layer.get(p) as number)) + 1);
  }
  return layer;
}

const SWEEPS = 2;

/**
 * Barycenter crossing reduction: each node drifts toward the average row of its
 * neighbours in the adjacent layer. Two sweeps each way is the usual stopping point —
 * further passes rarely move anything and would only cost determinism nothing.
 */
function orderLayers(
  layers: string[][],
  edges: readonly LayoutEdge[],
  present: Set<string>,
): string[][] {
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    succ.set(edge.source, [...(succ.get(edge.source) ?? []), edge.target]);
    pred.set(edge.target, [...(pred.get(edge.target) ?? []), edge.source]);
  }

  const ordered = layers.map((l) => [...l]);
  const indexIn = (layerIndex: number): Map<string, number> => {
    const map = new Map<string, number>();
    (ordered[layerIndex] ?? []).forEach((id, i) => map.set(id, i));
    return map;
  };

  const sweep = (from: number, to: number, step: number, neighbours: Map<string, string[]>) => {
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const reference = indexIn(i - step);
      const current = ordered[i];
      if (!current) continue;
      const key = new Map<string, number>();
      current.forEach((id, position) => {
        const linked = (neighbours.get(id) ?? []).map((other) => reference.get(other)).filter((v): v is number => v !== undefined);
        // No neighbour in the reference layer: hold position rather than jump to zero.
        key.set(id, linked.length === 0 ? position : linked.reduce((a, b) => a + b, 0) / linked.length);
      });
      current.sort((a, b) => (key.get(a) as number) - (key.get(b) as number) || (a < b ? -1 : a > b ? 1 : 0));
    }
  };

  for (let pass = 0; pass < SWEEPS; pass += 1) {
    sweep(1, ordered.length - 1, 1, pred);
    sweep(ordered.length - 2, 0, -1, succ);
  }
  return ordered;
}

/** Lay out one container's contents and report the box they occupy. */
function layoutGroup(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  sizeOf: (id: string) => Size,
  opts: LayoutOptions,
  into: Map<string, { x: number; y: number }>,
): Size {
  if (ids.length === 0) return { width: opts.nodeWidth, height: opts.nodeHeight };

  const layer = assignLayers(ids, edges);
  const depth = Math.max(...ids.map((id) => layer.get(id) as number));
  const buckets: string[][] = Array.from({ length: depth + 1 }, () => []);
  // Seeded in id order, which is what makes the whole result independent of input order.
  for (const id of [...ids].sort()) buckets[layer.get(id) as number]!.push(id);

  const ordered = orderLayers(buckets, edges, new Set(ids));

  // A column is as wide as its widest member — a loop frame, not a fixed node box.
  const columnWidth = ordered.map((column) => Math.max(...column.map((id) => sizeOf(id).width), opts.nodeWidth));
  const columnHeight = ordered.map((column) =>
    column.reduce((total, id, i) => total + sizeOf(id).height + (i > 0 ? opts.rowGap : 0), 0),
  );
  const tallest = Math.max(...columnHeight, opts.nodeHeight);

  let x = 0;
  ordered.forEach((column, index) => {
    // Centre each column on a shared axis so a diamond reads as a diamond.
    let y = (tallest - (columnHeight[index] as number)) / 2;
    for (const id of column) {
      const size = sizeOf(id);
      into.set(id, { x: x + ((columnWidth[index] as number) - size.width) / 2, y });
      y += size.height + opts.rowGap;
    }
    x += (columnWidth[index] as number) + opts.colGap;
  });

  return { width: Math.max(x - opts.colGap, opts.nodeWidth), height: tallest };
}

export function autoLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: Partial<LayoutOptions> = {},
): LayoutResult {
  const opts = { ...DEFAULT_LAYOUT, ...options };
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number }>();
  if (nodes.length === 0) return { positions, sizes };

  const group = resolveGroups(nodes);
  const members = new Map<string, string[]>();
  for (const node of nodes) {
    const key = group.get(node.id) as string;
    members.set(key, [...(members.get(key) ?? []), node.id]);
  }

  const sizeOf = (id: string): Size => sizes.get(id) ?? { width: opts.nodeWidth, height: opts.nodeHeight };

  // Deepest containers first: a frame cannot be placed until its own size is known,
  // and its size is only known once the body inside it has been laid out.
  const containers = nodes
    .filter((node) => node.isContainer && (members.get(node.id)?.length ?? 0) > 0)
    .map((node) => ({ id: node.id, depth: containerDepth(node.id, group) }))
    .sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : 1));

  for (const container of containers) {
    const box = layoutGroup(members.get(container.id) ?? [], edges, sizeOf, opts, positions);
    sizes.set(container.id, { width: box.width + opts.padX * 2, height: box.height + opts.padY + opts.padY / 2 });
    // Body coordinates are relative to the frame, so shift them clear of its header.
    for (const id of members.get(container.id) ?? []) {
      const p = positions.get(id);
      if (p) positions.set(id, { x: p.x + opts.padX, y: p.y + opts.padY });
    }
  }

  // An empty container still needs a frame worth drawing.
  for (const node of nodes) {
    if (node.isContainer && !sizes.has(node.id)) {
      sizes.set(node.id, { width: opts.nodeWidth + opts.padX * 2, height: opts.nodeHeight + opts.padY * 1.5 });
    }
  }

  layoutGroup(members.get('') ?? [], edges, sizeOf, opts, positions);
  return { positions, sizes };
}
