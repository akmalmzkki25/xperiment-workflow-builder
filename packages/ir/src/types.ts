export type NodeKind = 'trigger' | 'action' | 'logic';
export type EffectClass = 'pure' | 'read' | 'write';

export interface RetryPolicy {
  maxAttempts: number;
  strategy?: 'exponential-jitter';
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (number | 'timeout')[];
}

export interface NodeSettings {
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export interface IRNode {
  id: string;
  kind: NodeKind;
  type: string;
  operationVersion: string;
  parameters: Record<string, unknown>;
  settings?: NodeSettings;
  effectClass?: EffectClass;
}

export interface IREdge {
  id: string;
  from: { nodeId: string; port: string };
  to: { nodeId: string; port: string };
}

export interface WorkflowIR {
  schemaVersion: '0.1';
  workflow: { id: string; name: string };
  entrypoints: string[];
  nodes: IRNode[];
  edges: IREdge[];
  metadata?: { executionTimeoutMs?: number };
}
