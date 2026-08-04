import type { RegistryLike } from './registryLike.js';
import type { WorkflowIR } from './types.js';
import type { ValidationFinding } from './validate.js';

export function validateGraph(ir: WorkflowIR, registry: RegistryLike): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const g = (code: string, message: string, nodeId?: string) =>
    findings.push({ layer: 'graph', code, message, ...(nodeId !== undefined ? { nodeId } : {}) });

  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  for (const n of ir.nodes) {
    if (seen.has(n.id)) g('duplicate_node_id', `Duplicate node id '${n.id}'`, n.id);
    seen.add(n.id);
  }

  for (const e of ir.edges) {
    const from = nodeById.get(e.from.nodeId);
    const to = nodeById.get(e.to.nodeId);
    if (!from) g('unknown_edge_node', `Edge '${e.id}' references unknown source '${e.from.nodeId}'`);
    if (!to) g('unknown_edge_node', `Edge '${e.id}' references unknown target '${e.to.nodeId}'`);
    if (to && e.to.port !== 'input') g('invalid_input_port', `Edge '${e.id}' target port must be 'input'`, to.id);
    if (from) {
      const info = registry.get(from.type);
      // `error` is offered implicitly by every node. Making seventeen connectors declare it
      // would be churn carrying no information.
      if (info && e.from.port !== 'error' && !info.outputPorts.includes(e.from.port)) {
        g('unknown_output_port', `Edge '${e.id}' uses port '${e.from.port}' not offered by '${from.type}'`, from.id);
      }
    }
  }

  if (ir.entrypoints.length !== 1) {
    g('single_entrypoint_required', `Exactly one entrypoint required, got ${ir.entrypoints.length}`);
  }
  for (const ep of ir.entrypoints) {
    const n = nodeById.get(ep);
    if (!n) g('unknown_entrypoint', `Entrypoint '${ep}' does not exist`);
    else if (n.kind !== 'trigger') g('entrypoint_not_trigger', `Entrypoint '${ep}' must be a trigger node`, ep);
  }

  // adjacency for cycle + reachability (ignore edges to/from unknown nodes)
  const adj = new Map<string, string[]>(ir.nodes.map((n) => [n.id, []]));
  for (const e of ir.edges) {
    if (nodeById.has(e.from.nodeId) && nodeById.has(e.to.nodeId)) {
      adj.get(e.from.nodeId)!.push(e.to.nodeId);
    }
  }

  // cycle detection via DFS coloring
  const color = new Map<string, 0 | 1 | 2>();
  let cycle = false;
  const dfs = (id: string): void => {
    color.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) cycle = true;
      else if (c === 0) dfs(next);
    }
    color.set(id, 2);
  };
  for (const n of ir.nodes) if ((color.get(n.id) ?? 0) === 0) dfs(n.id);
  if (cycle) g('cycle_detected', 'Workflow graph contains a cycle');

  // reachability from the entrypoint
  const ep = ir.entrypoints[0];
  if (ep && nodeById.has(ep) && !cycle) {
    const reached = new Set<string>([ep]);
    const stack = [ep];
    while (stack.length) {
      for (const next of adj.get(stack.pop()!) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          stack.push(next);
        }
      }
    }
    for (const n of ir.nodes) {
      if (!reached.has(n.id)) g('unreachable_node', `Node '${n.id}' is not reachable from the entrypoint`, n.id);
    }
  }

  return findings;
}
