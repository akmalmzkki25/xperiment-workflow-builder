import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { guard, type AgentRunContext, type XperimentToolSpec } from './defineTool.js';
import type { AgentToolId } from './permissions.js';

/**
 * The Mastra seam, and the only file in the repo that imports it.
 *
 * Keeping `@mastra/core` to one module is the point: everything else — the guard, the
 * tools, the instructions — is plain TypeScript that can be tested without constructing
 * an agent at all, and a future engine swap touches this file and nothing else.
 */

export interface ToolEvent {
  callId: string;
  tool: AgentToolId;
  phase: 'start' | 'end';
  args: Record<string, unknown>;
  /** Only on 'end'. */
  result?: Record<string, unknown>;
  ok?: boolean;
  ms?: number;
}

export interface XperimentAgentConfig {
  instructions: string;
  specs: readonly XperimentToolSpec<never, never>[];
  ctx: AgentRunContext;
  model: { id: string; url: string; apiKey: string };
  onToolEvent: (event: ToolEvent) => void | Promise<void>;
  newCallId: () => string;
}

/**
 * Wraps each spec so nothing reaches `run` without passing the guard, and so the caller
 * sees a start and an end for every call. The context is closed over rather than carried
 * in Mastra's RequestContext because the agent is built per request anyway — and because
 * a RequestContext mutation inside one tool does not propagate to the next, which is
 * exactly what the run ledger needs to do.
 */
export function createXperimentAgent(config: XperimentAgentConfig): Agent {
  const tools = Object.fromEntries(
    config.specs.map((spec) => [
      spec.id,
      createTool({
        id: spec.id,
        description: spec.description,
        inputSchema: spec.inputSchema,
        execute: async (raw: unknown) => {
          const callId = config.newCallId();
          const args = (raw ?? {}) as Record<string, unknown>;
          const started = Date.now();
          await config.onToolEvent({ callId, tool: spec.id, phase: 'start', args });
          const result = (await guard(spec, raw as never, config.ctx)) as Record<string, unknown>;
          await config.onToolEvent({
            callId,
            tool: spec.id,
            phase: 'end',
            args,
            result,
            ok: result['error'] === undefined,
            ms: Date.now() - started,
          });
          return result;
        },
      }),
    ]),
  );

  return new Agent({
    id: 'xperiment-workflow-builder',
    name: 'Xperiment workflow builder',
    instructions: config.instructions,
    // The config-object form: its `url` wins over gateway resolution, which is how a test
    // points this at a local stub without touching the model id.
    model: config.model as never,
    tools,
  });
}

/** Prefixes a bare model name, so OPENROUTER_MODEL keeps working unchanged. */
export function modelConfig(ai: { apiKey: string; model: string; baseUrl: string }): {
  id: string;
  url: string;
  apiKey: string;
} {
  return {
    id: ai.model.includes('/') ? ai.model : `openrouter/${ai.model}`,
    url: `${ai.baseUrl.replace(/\/+$/, '')}/api/v1`,
    apiKey: ai.apiKey,
  };
}
