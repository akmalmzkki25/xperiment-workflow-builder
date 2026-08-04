export type NodeKind = 'trigger' | 'action' | 'logic';
export type EffectClass = 'pure' | 'read' | 'write';

export interface RetryPolicy {
  maxAttempts: number;
  strategy?: 'exponential-jitter';
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (number | 'timeout')[];
}

export type ErrorPolicy = 'fail' | 'continue';

export interface NodeSettings {
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** Falls back to the workflow-wide setting, which itself defaults to 'fail'. */
  onError?: ErrorPolicy;
}

export interface IRNode {
  id: string;
  kind: NodeKind;
  type: string;
  operationVersion: string;
  parameters: Record<string, unknown>;
  settings?: NodeSettings;
  effectClass?: EffectClass;
  /** Reference to a stored connection (credentials never live in the IR). */
  connectionRef?: string;
  /** Set on a node that lives inside a loop body. */
  scope?: { loopId: string };
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
  metadata?: {
    executionTimeoutMs?: number;
    /** Default error policy for every node that does not set its own. */
    onError?: ErrorPolicy;
    layout?: Record<string, { x: number; y: number }>;
  };
}
