import type { EffectClass, NodeKind } from '@xperiment/ir';
import type { z } from 'zod';

export interface NodeRunContext {
  executionId: string;
  nodeId: string;
  attempt: number;
  /** Parameters AFTER expression resolution (the worker resolves them). */
  parameters: unknown;
  triggerBody: unknown;
  /** Decrypted connection payload for connectors with requiresConnection. In-memory only. */
  connection?: unknown;
  signal: AbortSignal;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface NodeRunResult {
  output: unknown;
  outputPort?: string;
}

export class NodeRunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'NodeRunError';
  }
}

export interface ConnectorDefinition {
  type: string;
  kind: NodeKind;
  operationVersion: string;
  defaultEffectClass: EffectClass;
  outputPorts: string[];
  paramsSchema: z.ZodTypeAny;
  /** connector_key of the connection this node type needs (e.g. 'postgres'). */
  requiresConnection?: string;
  run(ctx: NodeRunContext): Promise<NodeRunResult>;
  /** Verifies a decrypted connection payload against the provider; throws on failure. */
  testConnection?(payload: unknown, signal: AbortSignal): Promise<void>;
}
