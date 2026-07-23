import { coreIf } from './core/if.js';
import { coreTransform } from './core/transform.js';
import { manualTrigger } from './manual/trigger.js';
import type { ConnectorDefinition } from './types.js';

export interface ConnectorRegistry {
  get(type: string): ConnectorDefinition | undefined;
  list(): ConnectorDefinition[];
}

export interface RegistryConfig {
  allowPrivateIps?: boolean;
}

export function createDefaultRegistry(_cfg: RegistryConfig = {}): ConnectorRegistry {
  const defs: ConnectorDefinition[] = [manualTrigger, coreTransform, coreIf];
  const byType = new Map(defs.map((d) => [d.type, d]));
  return {
    get: (type) => byType.get(type),
    list: () => [...byType.values()],
  };
}
