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

/**
 * Signals that a node should suspend the execution instead of completing. Uses
 * RELATIVE durations — the worker computes absolute resume_at/expires_at, so
 * connectors stay clock-free and deterministic.
 */
export type SuspendSpec =
  | { kind: 'timer'; delayMs: number }
  | { kind: 'event'; ttlMs?: number }
  | { kind: 'approval'; ttlMs: number; fallback: 'approve' | 'reject' | 'fail'; message: string };

export interface NodeRunResult {
  /** Node output. Omitted when the node suspends. */
  output?: unknown;
  outputPort?: string;
  /** When present, the worker suspends the node into WAITING instead of completing it. */
  suspend?: SuspendSpec;
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

/** What a human is shown for this connector, in the palette and on the canvas. */
export interface ConnectorDisplay {
  /** Title case, no dots — 'Send WhatsApp message', not 'whatsapp.sendMessage'. */
  displayName: string;
  /** One sentence, plain language: what it does and when you would reach for it. */
  description: string;
  /** Palette grouping. */
  category: 'Triggers' | 'Logic' | 'Data' | 'Messaging' | 'AI' | 'Integrations';
  /** A single character drawn on the node. */
  glyph: string;
  docsUrl?: string;
}

export interface ConnectorDefinition {
  type: string;
  kind: NodeKind;
  operationVersion: string;
  defaultEffectClass: EffectClass;
  outputPorts: string[];
  /**
   * Required, and nested under one key on purpose.
   *
   * Required because TypeScript is the only thing that will actually enforce it: an
   * optional side table rots silently, and this repo already proved that — NODE_GLYPHS
   * covered 10 of 26 connectors precisely because nothing made the other 16 fail.
   * Nested so a connector that forgets it is ONE compile error in one obvious place,
   * rather than four.
   */
  display: ConnectorDisplay;
  paramsSchema: z.ZodTypeAny;
  /** connector_key of the connection this node type needs (e.g. 'postgres'). */
  requiresConnection?: string;
  run(ctx: NodeRunContext): Promise<NodeRunResult>;
  /** Verifies a decrypted connection payload against the provider; throws on failure. */
  testConnection?(payload: unknown, signal: AbortSignal): Promise<void>;
}
