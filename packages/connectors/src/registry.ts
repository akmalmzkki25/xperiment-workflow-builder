import { coreIf } from './core/if.js';
import { coreTransform } from './core/transform.js';
import { createHttpRequest } from './http/request.js';
import { manualTrigger } from './manual/trigger.js';
import type { ConnectorDefinition } from './types.js';

export interface ConnectorRegistry {
  get(type: string): ConnectorDefinition | undefined;
  list(): ConnectorDefinition[];
}

export interface RegistryConfig {
  allowPrivateIps?: boolean;
}

export function createDefaultRegistry(cfg: RegistryConfig = {}): ConnectorRegistry {
  const defs: ConnectorDefinition[] = [
    manualTrigger,
    coreTransform,
    coreIf,
    createHttpRequest({ allowPrivateIps: cfg.allowPrivateIps ?? false }),
  ];
  const byType = new Map(defs.map((d) => [d.type, d]));
  return {
    get: (type) => byType.get(type),
    list: () => [...byType.values()],
  };
}
