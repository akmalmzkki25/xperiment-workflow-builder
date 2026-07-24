/**
 * Bidirectional mapping between the workflow IR definition JSON and the
 * React Flow canvas state. Kept UI-free so it can be unit-tested.
 */

export interface IRNodeData {
  id: string;
  kind: 'trigger' | 'action' | 'logic';
  type: string;
  operationVersion: string;
  parameters: Record<string, unknown>;
  settings?: Record<string, unknown>;
  effectClass?: string;
  connectionRef?: string;
}

export interface EditorNode {
  id: string;
  type: 'xperiment';
  position: { x: number; y: number };
  data: { ir: IRNodeData };
}

export interface EditorEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface CatalogItemLike {
  type: string;
  kind: 'trigger' | 'action' | 'logic';
  operationVersion: string;
  defaultEffectClass: string;
  outputPorts: string[];
  requiresConnection?: string;
  paramsJsonSchema: unknown;
}

const FALLBACK_X_START = 120;
const FALLBACK_X_STEP = 320;
const FALLBACK_Y = 160;

interface IRDefinitionShape {
  schemaVersion?: string;
  workflow?: { id: string; name: string };
  entrypoints?: string[];
  nodes?: IRNodeData[];
  edges?: { id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }[];
  metadata?: { executionTimeoutMs?: number; layout?: Record<string, { x: number; y: number }> };
}

function asDefinition(definition: unknown): IRDefinitionShape | null {
  if (typeof definition !== 'object' || definition === null) return null;
  const d = definition as IRDefinitionShape;
  if (!Array.isArray(d.nodes)) return null;
  return d;
}

const VALID_KINDS = new Set(['trigger', 'action', 'logic']);

function sanitizeNode(raw: unknown): IRNodeData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const node = raw as Record<string, unknown>;
  if (typeof node['id'] !== 'string' || node['id'].length === 0) return null;
  const kind = VALID_KINDS.has(node['kind'] as string) ? (node['kind'] as IRNodeData['kind']) : 'action';
  const parameters =
    typeof node['parameters'] === 'object' && node['parameters'] !== null
      ? (node['parameters'] as Record<string, unknown>)
      : {};
  return { ...(node as unknown as IRNodeData), kind, parameters };
}

export function definitionToCanvas(definition: unknown): { nodes: EditorNode[]; edges: EditorEdge[] } {
  const def = asDefinition(definition);
  if (!def) return { nodes: [], edges: [] };
  const layout = def.metadata?.layout ?? {};
  const nodes = (def.nodes ?? [])
    .map(sanitizeNode)
    .filter((ir): ir is IRNodeData => ir !== null)
    .map((ir, index): EditorNode => {
      const position = layout[ir.id] ?? { x: FALLBACK_X_START + index * FALLBACK_X_STEP, y: FALLBACK_Y };
      return { id: ir.id, type: 'xperiment', position: { x: position.x, y: position.y }, data: { ir } };
    });
  const rawEdges = Array.isArray(def.edges) ? def.edges : [];
  const edges = rawEdges
    .filter(
      (e): e is NonNullable<IRDefinitionShape['edges']>[number] =>
        typeof e === 'object' &&
        e !== null &&
        typeof e.id === 'string' &&
        typeof e.from === 'object' &&
        e.from !== null &&
        typeof e.from.nodeId === 'string' &&
        typeof e.to === 'object' &&
        e.to !== null &&
        typeof e.to.nodeId === 'string',
    )
    .map(
      (e): EditorEdge => ({
        id: e.id,
        source: e.from.nodeId,
        sourceHandle: typeof e.from.port === 'string' ? e.from.port : 'main',
        target: e.to.nodeId,
        targetHandle: typeof e.to.port === 'string' ? e.to.port : 'input',
      }),
    );
  return { nodes, edges };
}

export function canvasToDefinition(args: {
  workflowId: string;
  name: string;
  nodes: EditorNode[];
  edges: EditorEdge[];
  previous?: unknown;
}): Record<string, unknown> {
  if (args.nodes.length === 0) return {};
  const previous = asDefinition(args.previous ?? null);
  const layout: Record<string, { x: number; y: number }> = {};
  for (const node of args.nodes) {
    layout[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
  }
  const metadata: Record<string, unknown> = { layout };
  const previousTimeout = previous?.metadata?.executionTimeoutMs;
  if (previousTimeout !== undefined) metadata['executionTimeoutMs'] = previousTimeout;
  return {
    schemaVersion: '0.1',
    workflow: { id: args.workflowId, name: args.name },
    entrypoints: args.nodes.filter((n) => n.data.ir.kind === 'trigger').map((n) => n.id),
    nodes: args.nodes.map((n) => ({ ...n.data.ir, id: n.id })),
    edges: args.edges.map((e) => ({
      id: e.id,
      from: { nodeId: e.source, port: e.sourceHandle },
      to: { nodeId: e.target, port: e.targetHandle },
    })),
    metadata,
  };
}

export function edgeId(source: string, sourceHandle: string, target: string): string {
  const raw = `e_${source}_${sourceHandle}_${target}`;
  if (raw.length <= 64) return raw;
  // Deterministic cap: keep a readable prefix, disambiguate with a djb2 hash.
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  return `${raw.slice(0, 55)}_${hash.toString(36)}`;
}

export function remapEdgesForRename<
  T extends { id: string; source: string; target: string; sourceHandle?: string | null },
>(edges: T[], oldId: string, newId: string): T[] {
  return edges.map((edge) => {
    if (edge.source !== oldId && edge.target !== oldId) return edge;
    const source = edge.source === oldId ? newId : edge.source;
    const target = edge.target === oldId ? newId : edge.target;
    return { ...edge, source, target, id: edgeId(source, edge.sourceHandle ?? 'main', target) };
  });
}

export function nextNodeId(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function makeNode(
  item: CatalogItemLike,
  id: string,
  position: { x: number; y: number },
  defaults: Record<string, unknown>,
): EditorNode {
  return {
    id,
    type: 'xperiment',
    position,
    data: {
      ir: {
        id,
        kind: item.kind,
        type: item.type,
        operationVersion: item.operationVersion,
        parameters: defaults,
      },
    },
  };
}
