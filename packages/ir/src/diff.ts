import type { IRNode, WorkflowIR } from './types.js';

export interface NodeModification {
  nodeId: string;
  changedFields: string[];
}
export interface EdgeModification {
  edgeId: string;
}
export interface WorkflowDiff {
  nodes: { added: string[]; removed: string[]; modified: NodeModification[] };
  edges: { added: string[]; removed: string[]; modified: EdgeModification[] };
  changed: boolean;
}

const MAX_DEPTH = 200;

/**
 * Deterministic JSON with recursively sorted object keys, so parameter key
 * ordering never registers as a change. Depth-bounded so a pathologically deep
 * parameter payload cannot overflow the stack; `undefined` gets a distinct token
 * so it never collides with `null`.
 */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return '"__deep__"';
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], depth + 1)}`).join(',')}}`;
}

function nodeChangedFields(a: IRNode, b: IRNode): string[] {
  const fields: string[] = [];
  if (a.kind !== b.kind) fields.push('kind');
  if (a.type !== b.type) fields.push('type');
  if (a.operationVersion !== b.operationVersion) fields.push('operationVersion');
  if ((a.connectionRef ?? null) !== (b.connectionRef ?? null)) fields.push('connectionRef');
  if (stableStringify(a.parameters ?? {}) !== stableStringify(b.parameters ?? {})) fields.push('parameters');
  return fields;
}

/** Semantic diff of two workflow IRs (nodes + edges, keyed by id; layout-agnostic). */
export function diffWorkflows(from: WorkflowIR, to: WorkflowIR): WorkflowDiff {
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));
  const nAdded: string[] = [];
  const nRemoved: string[] = [];
  const nModified: NodeModification[] = [];
  for (const id of toNodes.keys()) if (!fromNodes.has(id)) nAdded.push(id);
  for (const [id, a] of fromNodes) {
    const b = toNodes.get(id);
    if (!b) {
      nRemoved.push(id);
      continue;
    }
    const changedFields = nodeChangedFields(a, b);
    if (changedFields.length > 0) nModified.push({ nodeId: id, changedFields });
  }

  const fromEdges = new Map(from.edges.map((e) => [e.id, e]));
  const toEdges = new Map(to.edges.map((e) => [e.id, e]));
  const eAdded: string[] = [];
  const eRemoved: string[] = [];
  const eModified: EdgeModification[] = [];
  for (const id of toEdges.keys()) if (!fromEdges.has(id)) eAdded.push(id);
  for (const [id, a] of fromEdges) {
    const b = toEdges.get(id);
    if (!b) {
      eRemoved.push(id);
      continue;
    }
    if (a.from.nodeId !== b.from.nodeId || a.from.port !== b.from.port || a.to.nodeId !== b.to.nodeId || a.to.port !== b.to.port) {
      eModified.push({ edgeId: id });
    }
  }

  const changed =
    nAdded.length + nRemoved.length + nModified.length + eAdded.length + eRemoved.length + eModified.length > 0;
  return {
    nodes: { added: nAdded, removed: nRemoved, modified: nModified },
    edges: { added: eAdded, removed: eRemoved, modified: eModified },
    changed,
  };
}
