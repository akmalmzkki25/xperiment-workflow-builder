import type { z } from 'zod';
import type { EffectClass, NodeKind } from './types.js';

export interface NodeTypeInfo {
  kind: NodeKind;
  paramsSchema: z.ZodTypeAny;
  defaultEffectClass: EffectClass;
  outputPorts: string[];
  requiresConnection?: string;
}

export interface RegistryLike {
  get(type: string): NodeTypeInfo | undefined;
}
