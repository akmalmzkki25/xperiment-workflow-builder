import type { ChatMessage } from './openrouter.js';

/** Mirrors @xperiment/connectors ConnectorCatalogItem (kept local to avoid a hard dep). */
export interface CatalogEntry {
  type: string;
  kind: string;
  operationVersion: string;
  outputPorts: string[];
  requiresConnection?: string;
  /** Optional so an older catalog still satisfies this shape. */
  description?: string;
  paramsJsonSchema: unknown;
}

export interface ConnectionSummary {
  id: string;
  connectorKey: string;
  name: string;
}

const IR_CONTRACT = `You design workflows for Xperiment. Return ONLY a single JSON object — no prose, no markdown fences — matching this contract:

{
  "schemaVersion": "0.1",
  "workflow": { "id": "wf_<slug>", "name": "<human name>" },
  "entrypoints": ["<id of each trigger-kind node>"],
  "nodes": [
    { "id": "<letters/digits/_/- , starts with a letter>", "kind": "trigger"|"action"|"logic",
      "type": "<one of the node types below>", "operationVersion": "<from the catalog>",
      "parameters": { ...match the node's parameter schema... },
      "connectionRef": "<a connection id below, only for nodes that requiresConnection>" }
  ],
  "edges": [ { "id": "e_<src>_<port>_<tgt>", "from": { "nodeId": "<id>", "port": "<output port>" },
              "to": { "nodeId": "<id>", "port": "input" } } ]
}

Rules:
- Use ONLY node types from the catalog; copy their operationVersion exactly.
- Every workflow needs exactly one trigger-kind node, listed in entrypoints.
- String parameters may contain expressions like {{ trigger.body.field }}, {{ nodes.<id>.output }}, or {{ execution.id }}. Roots are: trigger, nodes, execution.
- Nodes whose catalog entry has requiresConnection MUST set connectionRef to a listed connection id of the matching connectorKey. Never invent a connection id.
- core.if has output ports "true" and "false"; all other nodes output on "main".`;

export function buildSystemPrompt(catalog: CatalogEntry[], connections: ConnectionSummary[]): string {
  const catalogJson = JSON.stringify(
    catalog.map((c) => ({
      type: c.type,
      kind: c.kind,
      operationVersion: c.operationVersion,
      outputPorts: c.outputPorts,
      // A sentence of what the node does. The model was previously choosing between
      // twenty-six dotted identifiers and a JSON Schema, with nothing saying what any
      // of them were for.
      ...(c.description ? { description: c.description } : {}),
      ...(c.requiresConnection ? { requiresConnection: c.requiresConnection } : {}),
      parameters: c.paramsJsonSchema,
    })),
    null,
    2,
  );
  const connectionsBlock =
    connections.length > 0
      ? JSON.stringify(
          connections.map((c) => ({ id: c.id, connectorKey: c.connectorKey, name: c.name })),
          null,
          2,
        )
      : 'None. Do not use any node that requiresConnection.';
  return `${IR_CONTRACT}\n\nAVAILABLE NODE TYPES:\n${catalogJson}\n\nAVAILABLE CONNECTIONS:\n${connectionsBlock}`;
}

export function buildUserMessages(prompt: string, currentIr?: unknown): ChatMessage[] {
  if (currentIr === undefined) {
    return [{ role: 'user', content: `Build a workflow for this request:\n${prompt}` }];
  }
  return [
    {
      role: 'user',
      content: `Here is the current workflow:\n${JSON.stringify(currentIr)}\n\nApply this change and return the full updated workflow JSON:\n${prompt}`,
    },
  ];
}

export function repairMessage(findings: unknown): ChatMessage {
  return {
    role: 'user',
    content: `That workflow failed validation:\n${JSON.stringify(findings)}\n\nReturn the corrected full workflow JSON only.`,
  };
}
