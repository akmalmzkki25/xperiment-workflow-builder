/**
 * Copying and pasting canvas nodes, kept pure so the id-remapping rules are testable.
 *
 * Deliberately NOT the OS clipboard: navigator.clipboard.readText() prompts for a
 * permission, is unavailable on non-localhost http origins, and would let arbitrary
 * JSON be pasted onto the canvas. An in-memory clip is the right scope.
 */

import { edgeId, LOOP_TYPE, type EditorEdge, type EditorNode } from './irCanvas';

export interface Clip {
  nodes: EditorNode[];
  edges: EditorEdge[];
}

/**
 * The selection plus every node that only makes sense with it.
 *
 * Copying a loop container pulls its whole body along, transitively, because pasting an
 * empty frame is never what anyone meant. Edges survive only when BOTH endpoints are in
 * the set — a half-edge would point at a node the paste never created.
 */
export function copySelection(
  nodes: readonly EditorNode[],
  edges: readonly EditorEdge[],
  selectedIds: readonly string[],
): Clip {
  const onCanvas = new Set(nodes.map((n) => n.id));
  const keep = new Set(selectedIds.filter((id) => onCanvas.has(id)));

  // Fixpoint rather than one pass: a loop body may itself contain a loop.
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes) {
      if (n.parentNode && keep.has(n.parentNode) && !keep.has(n.id)) {
        keep.add(n.id);
        grew = true;
      }
    }
  }

  return {
    // Canvas order, not selection order, so a paste reads the way the original did.
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

function freshId(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

/**
 * A copy of the clip with fresh ids, ready to append to the canvas.
 *
 * The whole id map is built BEFORE anything is rewritten. Remapping one pair at a time
 * — the way a rename does — is unsafe here: an id minted for the first node can collide
 * with an original id that has not been remapped yet, and the edges would then be
 * rewired to the wrong node without any error.
 */
export function pasteCanvas(
  clip: Clip,
  existingIds: readonly string[],
  offset: { x: number; y: number },
): { nodes: EditorNode[]; edges: EditorEdge[] } {
  const taken = new Set(existingIds);
  const idMap = new Map<string, string>();
  for (const n of clip.nodes) {
    const id = freshId(taken, n.id);
    taken.add(id); // so the next pasted node cannot claim the same one
    idMap.set(n.id, id);
  }

  const nodes = clip.nodes.map((n): EditorNode => {
    const id = idMap.get(n.id) as string;
    const parentNode = n.parentNode ? idMap.get(n.parentNode) : undefined;
    const { scope: _dropped, ...ir } = n.data.ir;
    return {
      id,
      type: n.data.ir.type === LOOP_TYPE ? 'xperimentLoop' : n.type,
      // A child's position is relative to its container, so offsetting it too would
      // push the body out of the frame it is drawn inside.
      position: parentNode ? { ...n.position } : { x: n.position.x + offset.x, y: n.position.y + offset.y },
      data: { ir: { ...ir, id, ...(parentNode ? { scope: { loopId: parentNode } } : {}) } },
      // Dropped when the container did not come along: canvasToDefinition turns
      // parentNode into scope.loopId, so a dangling parent would be saved as
      // membership of a loop this node was never in.
      ...(parentNode ? { parentNode, extent: 'parent' as const } : {}),
    };
  });

  const edges = clip.edges.map((e): EditorEdge => {
    const source = idMap.get(e.source) as string;
    const target = idMap.get(e.target) as string;
    return { id: edgeId(source, e.sourceHandle, target), source, sourceHandle: e.sourceHandle, target, targetHandle: e.targetHandle };
  });

  return { nodes, edges };
}
