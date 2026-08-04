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

/**
 * Where a node's failure goes. An explicit `error` edge is the author's instruction and wins;
 * otherwise the effective policy decides between carrying on down `main` and ending the run.
 * Returns null when the failure is fatal.
 */
export function errorRouting(ir: WorkflowIR, nodeId: string): { port: string } | null {
  if (ir.edges.some((e) => e.from.nodeId === nodeId && e.from.port === 'error')) return { port: 'error' };
  const node = ir.nodes.find((n) => n.id === nodeId);
  const policy = node?.settings?.onError ?? ir.metadata?.onError ?? 'fail';
  return policy === 'continue' ? { port: 'main' } : null;
}

/** What a node's recorded state means for scheduling. */
interface Resolved {
  /** The node will not change again, so its downstream may be decided. */
  decided: boolean;
  /** Which outgoing port is live; null when none is. */
  activePort: string | null;
  /** An unhandled failure: the execution is over. */
  fatal: boolean;
}

export function computeReadiness(ir: WorkflowIR, outcomes: NodeOutcome[]): ReadinessResult {
  const status = new Map<string, NodeStatus>(outcomes.map((o) => [o.nodeId, o.status]));
  const port = new Map<string, string | null>(outcomes.map((o) => [o.nodeId, o.outputPort ?? null]));
  const inbound = new Map<string, { from: string; port: string }[]>();
  for (const n of ir.nodes) inbound.set(n.id, []);
  for (const e of ir.edges) inbound.get(e.to.nodeId)?.push({ from: e.from.nodeId, port: e.from.port });

  const skipped = new Set<string>();
  const raw = (id: string): NodeStatus => (skipped.has(id) ? 'SKIPPED' : (status.get(id) ?? 'PENDING'));

  const resolve = (id: string): Resolved => {
    const s = raw(id);
    if (s === 'SUCCEEDED') return { decided: true, activePort: port.get(id) ?? 'main', fatal: false };
    if (s === 'SKIPPED') return { decided: true, activePort: null, fatal: false };
    if (s === 'FAILED') {
      const routed = errorRouting(ir, id);
      return routed
        ? { decided: true, activePort: routed.port, fatal: false }
        : { decided: true, activePort: null, fatal: true };
    }
    return { decided: false, activePort: null, fatal: false };
  };

  // Propagate skips to fixpoint: a PENDING node all of whose inbound edges are inactive
  // becomes SKIPPED. An unhandled failure has no active port, so it skips its downstream
  // here rather than in the orchestrator.
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of ir.nodes) {
      const edges = inbound.get(n.id)!;
      if (edges.length === 0) continue; // entrypoint, or a synthetic join the orchestrator seeds
      if (raw(n.id) !== 'PENDING') continue;
      const allInactive = edges.every((e) => {
        const r = resolve(e.from);
        return r.decided && r.activePort !== e.port;
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
    if (raw(n.id) !== 'PENDING') continue;
    const active = edges.filter((e) => {
      const r = resolve(e.from);
      return r.decided && r.activePort === e.port;
    });
    const undecided = edges.some((e) => !resolve(e.from).decided);
    if (active.length > 0 && !undecided) ready.push(n.id);
  }

  const resolved = ir.nodes.map((n) => resolve(n.id));
  let terminal: ReadinessResult['terminal'] = null;
  if (resolved.some((r) => r.fatal)) terminal = 'FAILED';
  else if (resolved.every((r) => r.decided)) terminal = 'SUCCEEDED';

  return { ready, skipped: [...skipped], terminal };
}
