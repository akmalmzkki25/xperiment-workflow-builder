import type { WorkflowIR } from '@xperiment/ir';
import type { NodeStatus } from './states.js';

export interface NodeOutcome {
  nodeId: string;
  status: NodeStatus;
  outputPort?: string | null;
}

export interface ReadinessResult {
  ready: string[];
  skipped: string[];
  terminal: 'SUCCEEDED' | 'FAILED' | null;
}

export function computeReadiness(ir: WorkflowIR, outcomes: NodeOutcome[]): ReadinessResult {
  const status = new Map<string, NodeStatus>(outcomes.map((o) => [o.nodeId, o.status]));
  const port = new Map<string, string | null>(outcomes.map((o) => [o.nodeId, o.outputPort ?? null]));
  const inbound = new Map<string, { from: string; port: string }[]>();
  for (const n of ir.nodes) inbound.set(n.id, []);
  for (const e of ir.edges) inbound.get(e.to.nodeId)?.push({ from: e.from.nodeId, port: e.from.port });

  const skipped = new Set<string>();
  const effective = (id: string): NodeStatus => (skipped.has(id) ? 'SKIPPED' : (status.get(id) ?? 'PENDING'));

  // Propagate skips to fixpoint: a PENDING node all of whose inbound edges are
  // inactive (source SKIPPED, or source SUCCEEDED with a different selected port)
  // becomes SKIPPED.
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of ir.nodes) {
      const edges = inbound.get(n.id)!;
      if (edges.length === 0) continue; // entrypoint: orchestrator seeds it directly
      if (effective(n.id) !== 'PENDING') continue;
      const allInactive = edges.every((e) => {
        const s = effective(e.from);
        if (s === 'SKIPPED') return true;
        if (s === 'SUCCEEDED') return (port.get(e.from) ?? 'main') !== e.port;
        return false;
      });
      if (allInactive) {
        skipped.add(n.id);
        changed = true;
      }
    }
  }

  const ready: string[] = [];
  for (const n of ir.nodes) {
    const edges = inbound.get(n.id)!;
    if (edges.length === 0) continue;
    if (effective(n.id) !== 'PENDING') continue;
    const active = edges.filter((e) => {
      const s = effective(e.from);
      return s === 'SUCCEEDED' && (port.get(e.from) ?? 'main') === e.port;
    });
    const undecided = edges.some((e) => !['SUCCEEDED', 'SKIPPED'].includes(effective(e.from)));
    if (active.length > 0 && !undecided) ready.push(n.id);
  }

  let terminal: ReadinessResult['terminal'] = null;
  const statuses = ir.nodes.map((n) => effective(n.id));
  if (statuses.includes('FAILED')) terminal = 'FAILED';
  else if (statuses.every((s) => s === 'SUCCEEDED' || s === 'SKIPPED')) terminal = 'SUCCEEDED';

  return { ready, skipped: [...skipped], terminal };
}
