import type { RegistryLike } from './registryLike.js';
import type { WorkflowIR } from './types.js';

/**
 * Moving a workflow out of the product and back in.
 *
 * A workflow somebody built over three weeks could not be backed up, copied, or moved to
 * another workspace. Templates clone; your own work did not.
 *
 * The whole design question is `connectionRef`. It is a UUID pointing at a row in ONE
 * workspace's connections table. Carried into another workspace it resolves to nothing —
 * and the failure surfaces at publish as `connection_not_found` on a node the person did
 * not know they had to look at. So the export carries a manifest of what each reference
 * WAS for, and the import decides per reference.
 */

export const EXPORT_FORMAT = 1;

/** The key that carries the format version in an export document. */
export const FORMAT_KEY = 'xperimentExport';

/** The declared format version of an export document, if it has one. */
export function readFormat(doc: Record<string, unknown>): number | undefined {
  const v = doc[FORMAT_KEY];
  return typeof v === 'number' ? v : undefined;
}

/** What a node needed a connection for, in words rather than a UUID. */
export interface RequiredConnection {
  nodeId: string;
  connectorKey: string;
  /** Whether the node carried a reference at all when it was exported. */
  wasConnected: boolean;
}

export interface WorkflowExport {
  xperimentExport: number;
  name: string;
  definition: WorkflowIR;
  requiredConnections: RequiredConnection[];
}

/**
 * Which nodes need a connection, and what kind.
 *
 * Derived from the registry rather than trusted from the file: an export that claimed a
 * node needed `postgres` when the connector says `telegram` would otherwise let an import
 * wire the wrong credential in.
 */
export function requiredConnections(ir: WorkflowIR, registry: RegistryLike): RequiredConnection[] {
  const out: RequiredConnection[] = [];
  for (const node of ir.nodes) {
    const key = registry.get(node.type)?.requiresConnection;
    if (!key) continue;
    out.push({ nodeId: node.id, connectorKey: key, wasConnected: node.connectionRef !== undefined });
  }
  return out;
}

/**
 * The document to hand somebody.
 *
 * Carries `metadata.layout`, so the canvas survives the round trip — an import that
 * stacked every node at the origin would be technically complete and practically
 * useless. Carries no secrets, because none live in the IR: connection payloads and
 * trigger secrets are separate rows and were never part of a definition.
 */
export function buildExport(name: string, ir: WorkflowIR, registry: RegistryLike): WorkflowExport {
  return {
    xperimentExport: EXPORT_FORMAT,
    name,
    definition: ir,
    requiredConnections: requiredConnections(ir, registry),
  };
}

export interface ImportPlan {
  definition: WorkflowIR;
  /** Nodes whose connection did not survive, and what they need reconnecting to. */
  reconnect: RequiredConnection[];
}

export interface ImportRequest {
  ir: WorkflowIR;
  registry: RegistryLike;
  connections: readonly { id: string; connectorKey: string }[];
  /** The row this definition is about to belong to. */
  identity: { id: string; name: string };
}

/**
 * Rewrite an incoming definition for the workspace receiving it.
 *
 * A reference is KEPT when it resolves to a connection of the right connector in this
 * workspace — which is what makes an import into the same workspace a true duplicate,
 * fully wired. Otherwise it is STRIPPED and reported.
 *
 * Stripping rather than leaving it dangling is the deliberate half. A surviving foreign
 * UUID would fail validation later with `connection_not_found` on a node nobody was told
 * about; removing it produces `connection_required` on exactly the nodes this function
 * already named, so the two agree.
 *
 * `identity` is a required argument rather than a second function the caller composes,
 * because a caller who forgot it would store a definition still claiming the source
 * workflow's id — silently, and only until somebody's next Save quietly corrected it.
 */
export function planImport({ ir, registry, connections, identity }: ImportRequest): ImportPlan {
  const byId = new Map(connections.map((c) => [c.id, c.connectorKey]));
  const reconnect: RequiredConnection[] = [];
  const nodes = ir.nodes.map((node) => {
    const key = registry.get(node.type)?.requiresConnection;
    if (!key) {
      // A node that needs no connection must not keep a stray reference either.
      if (node.connectionRef === undefined) return node;
      const { connectionRef: _dropped, ...rest } = node;
      return rest;
    }
    const resolves = node.connectionRef !== undefined && byId.get(node.connectionRef) === key;
    if (resolves) return node;
    reconnect.push({ nodeId: node.id, connectorKey: key, wasConnected: node.connectionRef !== undefined });
    if (node.connectionRef === undefined) return node;
    const { connectionRef: _dropped, ...rest } = node;
    return rest;
  });
  return { definition: { ...ir, workflow: { ...identity }, nodes }, reconnect };
}
