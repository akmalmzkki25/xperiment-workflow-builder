import type { EffectClass, NodeKind } from '@xperiment/ir';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
