import type { ConnectorRegistry } from '@xperiment/connectors';
import type { Db } from '@xperiment/db';
import type { z } from 'zod';
import type { AgentToolId, RequiredPermission } from './permissions.js';

/**
 * The one place a tool's permission is checked, its writes are counted, and its call is
 * recorded.
 *
 * Kept as a plain function rather than folded into Mastra's `createTool` so it can be
 * tested without any of Mastra's machinery — the same split as `runChatTurn` versus the
 * Fastify route. `createTool` wraps this; nothing else may call a tool's `run` directly.
 */

/** A turn may change this much and no more. Six is enough to build and wire a workflow. */
export const MAX_WRITES_PER_TURN = 6;

/** Argument names whose *values* never reach the transcript. */
const SECRET_KEY = /token|secret|password|api[-_]?key|credential|authorization|private[-_]?key/i;

export interface ToolCallRecord {
  tool: AgentToolId;
  /** Redacted at the moment of recording, not at the moment of writing to the database. */
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
}

export interface RunState {
  /** Accumulated in `onStepFinish`, which fires per step and survives a run that throws. */
  tokens: { input: number; output: number };
  writes: number;
  toolCalls: ToolCallRecord[];
  /** Set by `create_workflow`, so a second call in one turn gets the same id back. */
  createdWorkflowId?: string;
  credentialRequests: string[];
}

export function freshRunState(): RunState {
  return { tokens: { input: 0, output: 0 }, writes: 0, toolCalls: [], credentialRequests: [] };
}

/**
 * Everything a tool is allowed to know. Assembled per request from the authenticated
 * caller, never from anything the model said.
 */
export interface AgentRunContext {
  pool: Db;
  registry: ConnectorRegistry;
  /** From `authOf(req)`. No tool input schema has a field that could carry this. */
  workspaceId: string;
  userId: string | null;
  grantedPermissions: ReadonlySet<RequiredPermission>;
  runState: RunState;
  /** Set once the turn has a transcript to attach a credential request to. */
  conversationId?: string;
  /** Where the browser is, for the connection-form link. From ResolvedServerDeps. */
  appUrl?: string;
}

export interface XperimentToolSpec<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  id: AgentToolId;
  description: string;
  /** Required, not optional: a tool that forgets it is one compile error in one place. */
  permission: RequiredPermission;
  /** Whether the tool writes. Drives the per-turn write budget and the audit row. */
  mutates: boolean;
  inputSchema: I;
  outputSchema: O;
  run(input: z.infer<I>, ctx: AgentRunContext): Promise<z.infer<O>>;
}

export interface ToolError {
  error: string;
  message: string;
  [key: string]: unknown;
}

/** Values dropped, keys kept — the shape of a call is useful, its secrets are not. */
function redactArgs(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : v;
  }
  return out;
}

export async function guard<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: XperimentToolSpec<I, O>,
  input: z.infer<I>,
  ctx: AgentRunContext,
): Promise<z.infer<O> | ToolError> {
  if (!ctx.grantedPermissions.has(spec.permission)) {
    // Returned rather than thrown: a thrown tool kills the turn, while a typed error lets
    // the model relay "that needs a workspace admin", which is the useful answer.
    return {
      error: 'forbidden',
      permission: spec.permission,
      message: `This needs the ${spec.permission} permission. Ask a workspace admin.`,
    };
  }
  if (spec.mutates && ctx.runState.writes >= MAX_WRITES_PER_TURN) {
    return {
      error: 'write_budget_exhausted',
      message: `A single turn may make ${MAX_WRITES_PER_TURN} changes. Summarise what is left and ask the user to continue.`,
    };
  }

  const started = Date.now();
  if (spec.mutates) ctx.runState.writes += 1;
  try {
    const out = await spec.run(input, ctx);
    ctx.runState.toolCalls.push({ tool: spec.id, args: redactArgs(input), ok: true, ms: Date.now() - started });
    return out;
  } catch (e) {
    ctx.runState.toolCalls.push({ tool: spec.id, args: redactArgs(input), ok: false, ms: Date.now() - started });
    // The thrown text is never relayed. A tool talks to Postgres and to providers, and
    // their error messages have a habit of quoting back what was sent to them.
    void e;
    return { error: 'tool_failed', message: 'That step failed. Try a different approach, or tell the user what is stuck.' };
  }
}
