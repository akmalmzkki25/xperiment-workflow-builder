import type { EffectClass, NodeKind } from '@xperiment/ir';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CONNECTION_PAYLOAD_SCHEMAS } from './payloads.js';
import type { ConnectorRegistry } from './registry.js';

export interface ConnectorCatalogItem {
  type: string;
  kind: NodeKind;
  operationVersion: string;
  defaultEffectClass: EffectClass;
  outputPorts: string[];
  requiresConnection?: string;
  /**
   * Display metadata, FLATTENED rather than nested.
   *
   * The AI package keeps its own structural copy of this shape to avoid a hard
   * dependency; flat optional strings stay assignable to it, and the web search layer
   * already reads exactly these names.
   */
  displayName: string;
  description: string;
  category: string;
  glyph: string;
  docsUrl?: string;
  /** Draft-7 JSON Schema of the node parameters, for schema-driven UIs. */
  paramsJsonSchema: unknown;
}

export function connectorCatalog(registry: ConnectorRegistry): ConnectorCatalogItem[] {
  return registry.list().map((def) => ({
    type: def.type,
    kind: def.kind,
    operationVersion: def.operationVersion,
    defaultEffectClass: def.defaultEffectClass,
    outputPorts: def.outputPorts,
    ...(def.requiresConnection ? { requiresConnection: def.requiresConnection } : {}),
    displayName: def.display.displayName,
    description: def.display.description,
    category: def.display.category,
    glyph: def.display.glyph,
    ...(def.display.docsUrl ? { docsUrl: def.display.docsUrl } : {}),
    paramsJsonSchema: zodToJsonSchema(def.paramsSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
  }));
}

export interface ConnectionSchemaItem {
  connectorKey: string;
  /** Draft-7 JSON Schema of the connection payload, for schema-driven forms. */
  payloadJsonSchema: unknown;
}

/**
 * The payload shape each connection type accepts, served from the same object that
 * validates it.
 *
 * The web form used to carry a hand-written copy of this, whose own docblock conceded it
 * would drift. It drifts in exactly one direction that matters: a field added on the
 * server is invisible in the form, so the connection saves without it and fails at the
 * first run with a validation error nobody can trace to a missing input.
 *
 * Caveat worth knowing before relying on this: `zodToJsonSchema` silently drops
 * `.refine()`. None of these schemas use one today, and a future refine would be a
 * cross-field rule the form could not render anyway — but it would vanish here without
 * a word.
 */
export function connectionSchemas(): ConnectionSchemaItem[] {
  return Object.entries(CONNECTION_PAYLOAD_SCHEMAS).map(([connectorKey, schema]) => ({
    connectorKey,
    payloadJsonSchema: zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }),
  }));
}
