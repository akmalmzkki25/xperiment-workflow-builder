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
    paramsJsonSchema: zodToJsonSchema(def.paramsSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
  }));
}
