import type { WorkflowIR } from '@xperiment/ir';

const INSTANCE_SEPARATOR = '#';
const JOIN_SUFFIX = '$join';

/**
 * The id of one iteration's copy of a body node. The IR id pattern forbids '#' and '$', so
 * neither this nor a join id can ever collide with an id an author wrote.
 */
export function instanceId(nodeId: string, iteration: number): string {
  return `${nodeId}${INSTANCE_SEPARATOR}${iteration}`;
}

export function parseInstanceId(id: string): { nodeId: string; iteration: number } | null {
  const at = id.lastIndexOf(INSTANCE_SEPARATOR);
  if (at <= 0) return null;
  const suffix = id.slice(at + 1);
  if (!/^\d+$/.test(suffix)) return null;
  return { nodeId: id.slice(0, at), iteration: Number(suffix) };
}

export function joinId(loopId: string): string {
  return `${loopId}${JOIN_SUFFIX}`;
}

export function isJoinId(id: string): boolean {
  return id.endsWith(JOIN_SUFFIX);
}

/**
 * Rewrites loops out of the graph so the scheduler never has to know they exist.
 *
 * A loop whose item count is unknown — it has not succeeded yet — is left unexpanded, and its
 * body nodes are dropped from the derived IR along with every edge touching them. That is what
 * stops a body node from being scheduled before the loop that owns it.
 *
 * A loop with zero items needs no rewrite either: `core.loop` selects its `done` port in that
 * case, so its original done edges fire directly and no join is emitted. Emitting one would
 * hang the run, because a join has no inbound edges and readiness skips such a node entirely.
 */
export function expandLoops(ir: WorkflowIR, iterationCounts: Record<string, number>): WorkflowIR {
  const loopIds = new Set(ir.nodes.filter((n) => n.type === 'core.loop').map((n) => n.id));
  if (loopIds.size === 0) return ir;

  const expanded = new Map<string, number>();
  for (const id of loopIds) {
    const count = iterationCounts[id];
    if (typeof count === 'number' && count > 0) expanded.set(id, count);
  }

  const scopeOf = new Map(ir.nodes.filter((n) => n.scope).map((n) => [n.id, n.scope!.loopId]));

  const nodes: WorkflowIR['nodes'] = ir.nodes.filter((n) => n.scope === undefined).map((n) => ({ ...n }));
  for (const [loopId, count] of expanded) {
    const body = ir.nodes.filter((n) => n.scope?.loopId === loopId);
    for (let i = 0; i < count; i += 1) {
      for (const n of body) nodes.push({ ...n, id: instanceId(n.id, i) });
    }
    // Virtual: it has no inbound edges and is never dispatched. The orchestrator writes its
    // outcome once every instance of this loop is decided, which is what lets `done` fire.
    nodes.push({
      id: joinId(loopId),
      kind: 'logic',
      type: 'core.join',
      operationVersion: '0.1.0',
      parameters: {},
    });
  }

  const edges: WorkflowIR['edges'] = [];
  for (const e of ir.edges) {
    const fromScope = scopeOf.get(e.from.nodeId);
    const toScope = scopeOf.get(e.to.nodeId);

    // Wholly inside one body: one copy per iteration, never crossing between them.
    if (fromScope !== undefined && fromScope === toScope) {
      const count = expanded.get(fromScope);
      if (count === undefined) continue; // unexpanded body: dropped with its nodes
      for (let i = 0; i < count; i += 1) {
        edges.push({
          id: `${e.id}${INSTANCE_SEPARATOR}${i}`,
          from: { nodeId: instanceId(e.from.nodeId, i), port: e.from.port },
          to: { nodeId: instanceId(e.to.nodeId, i), port: e.to.port },
        });
      }
      continue;
    }

    // A loop's `item` edge into its body entry: one per iteration.
    if (toScope !== undefined && e.from.nodeId === toScope) {
      const count = expanded.get(toScope);
      if (count === undefined) continue;
      for (let i = 0; i < count; i += 1) {
        edges.push({
          id: `${e.id}${INSTANCE_SEPARATOR}${i}`,
          from: { nodeId: e.from.nodeId, port: e.from.port },
          to: { nodeId: instanceId(e.to.nodeId, i), port: e.to.port },
        });
      }
      continue;
    }

    // A `done` edge out of an expanded loop now leaves the join instead.
    if (expanded.has(e.from.nodeId) && e.from.port === 'done') {
      edges.push({ ...e, from: { nodeId: joinId(e.from.nodeId), port: 'main' } });
      continue;
    }

    // Anything still touching a scoped node belongs to an unexpanded body.
    if (fromScope !== undefined || toScope !== undefined) continue;
    edges.push(e);
  }

  return { ...ir, nodes, edges };
}
