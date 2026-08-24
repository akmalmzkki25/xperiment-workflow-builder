import { randomUUID } from 'node:crypto';
import {
  buildCatalogIndex,
  buildInstructions,
  createXperimentAgent,
  freshRunState,
  modelConfig,
  READ_TOOLS,
  WRITE_TOOLS,
  type AgentRunContext,
  type XperimentToolSpec,
  type RequiredPermission,
  type ToolEvent,
} from '@xperiment/agent';
import { connectorCatalog, type ConnectorRegistry } from '@xperiment/connectors';
import { appendAgentMessage, getDraft, listConnections, looksLikeCredential, type Db } from '@xperiment/db';
import { toolTitle, type ChatFrame, type Emit, type StopReason } from './frames.js';

/**
 * One turn of the conversation, with no Fastify anywhere in it.
 *
 * `app.inject()` cannot drive a hijacked reply, and every route test in this app uses it.
 * So the turn takes an `emit` callback and the route becomes a wire adapter — the same
 * split that kept `generateWorkflow` testable while `routes/ai.ts` stayed thin.
 */

/** Tool calls per turn. Twelve is enough to build, wire and check a workflow twice over. */
const MAX_STEPS = 12;

export interface ChatTurnDeps {
  pool: Db;
  registry: ConnectorRegistry;
  ai: { apiKey: string; model: string; baseUrl: string };
  appUrl?: string;
}

export interface ChatTurnInput {
  workspaceId: string;
  userId: string | null;
  conversationId: string;
  /** Prior turns, oldest first, already loaded from the transcript. */
  history: { role: 'user' | 'assistant'; content: string }[];
  prompt: string;
  grantedPermissions: ReadonlySet<RequiredPermission>;
  signal: AbortSignal;
}

export interface ChatTurnResult {
  stopReason: StopReason;
  tokens: number;
}

const ALL_SPECS = [...READ_TOOLS, ...WRITE_TOOLS] as unknown as readonly XperimentToolSpec<never, never>[];

/**
 * A credential pasted into the chat box.
 *
 * Refused rather than scrubbed: a redacted transcript still means the value transited the
 * logs and, worse, went upstream to the model provider. The only safe response is to not
 * take the turn at all.
 */
const REFUSAL =
  'That looks like a credential, and it must not go in the chat — it would be stored in this transcript and sent to the model. Revoke it and issue a new one, then use the connection form, which encrypts it per workspace.';

export async function runChatTurn(deps: ChatTurnDeps, input: ChatTurnInput, emit: Emit): Promise<ChatTurnResult> {
  const turnId = randomUUID();
  const conversation = input.conversationId;

  const ctx: AgentRunContext = {
    pool: deps.pool,
    registry: deps.registry,
    workspaceId: input.workspaceId,
    userId: input.userId,
    grantedPermissions: input.grantedPermissions,
    runState: freshRunState(),
    conversationId: conversation,
    ...(deps.appUrl ? { appUrl: deps.appUrl } : {}),
  };

  await emit({ type: 'turn', turnId, conversationId: conversation, workflowId: null });

  // Before anything is stored or sent anywhere.
  if (looksLikeCredential(input.prompt)) {
    await appendAgentMessage(deps.pool, {
      conversationId: conversation,
      workspaceId: input.workspaceId,
      role: 'user',
      // The message itself is NOT persisted — that is the whole point of refusing.
      content: '[message withheld: looked like a credential]',
      outcome: 'refused',
    });
    await emit({ type: 'text', messageId: randomUUID(), delta: REFUSAL });
    await emit({ type: 'done', turnId, stopReason: 'refused', tokens: 0 });
    return { stopReason: 'refused', tokens: 0 };
  }

  await appendAgentMessage(deps.pool, {
    conversationId: conversation,
    workspaceId: input.workspaceId,
    role: 'user',
    content: input.prompt,
  });

  let stopReason: StopReason = 'complete';
  const messageId = randomUUID();
  let assistantText = '';

  const onToolEvent = async (ev: ToolEvent): Promise<void> => {
    if (ev.phase === 'start') {
      await emit({ type: 'tool.start', callId: ev.callId, tool: ev.tool, title: toolTitle(ev.tool, false), args: safeArgs(ev.args) });
      return;
    }
    const result = ev.result ?? {};
    await emit({
      type: 'tool.end',
      callId: ev.callId,
      tool: ev.tool,
      ok: ev.ok === true,
      summary: ev.ok === true ? toolTitle(ev.tool, true) : String(result['error'] ?? 'failed'),
      ms: ev.ms ?? 0,
    });
    await afterTool(deps, ctx, ev.tool, ev.args, result, emit);
  };

  const connections = (await listConnections(deps.pool, input.workspaceId)).map((c) => ({
    id: c.id,
    connectorKey: c.connectorKey,
    name: c.name,
  }));
  const agent = createXperimentAgent({
    instructions: buildInstructions({
      catalogIndex: buildCatalogIndex(connectorCatalog(deps.registry)),
      connections,
    }),
    specs: ALL_SPECS,
    ctx,
    model: modelConfig(deps.ai),
    onToolEvent,
    newCallId: () => randomUUID(),
  });

  try {
    const stream = await (agent.stream as (m: unknown, o: unknown) => Promise<{ textStream: AsyncIterable<string> }>)(
      [...input.history, { role: 'user' as const, content: input.prompt }],
      {
        maxSteps: MAX_STEPS,
        abortSignal: input.signal,
        // Measured during the spike: onStepFinish fires per step, carries usage, and
        // fires on a run that then throws — while the thrown error carries neither steps
        // nor usage. Summing steps in a `finally` would record zero for exactly the
        // failure it existed to cover.
        onStepFinish: (step: unknown) => {
          const u = (step as { usage?: Record<string, number> })?.usage;
          if (u) {
            ctx.runState.tokens.input += Number(u['inputTokens'] ?? 0);
            ctx.runState.tokens.output += Number(u['outputTokens'] ?? 0);
          }
        },
      },
    );

    for await (const delta of stream.textStream) {
      if (input.signal.aborted) break;
      assistantText += delta;
      await emit({ type: 'text', messageId, delta });
    }
    if (input.signal.aborted) stopReason = 'aborted';
    else if (ctx.runState.credentialRequests.length > 0) stopReason = 'awaiting_connection';
    else if (assistantText.length === 0 && ctx.runState.toolCalls.length === 0) {
      // Measured: a provider 500 does not make agent.stream() throw. The text stream
      // simply ends empty and the turn reports success — so somebody watching would see
      // nothing at all and conclude the product is broken rather than the provider.
      // A turn that said nothing and did nothing is a failure whatever the cause.
      stopReason = 'error';
      await emit({
        type: 'error',
        code: 'provider_error',
        title: 'The AI provider returned nothing',
        detail: 'Nothing was said and no step was taken. Try again.',
        retriable: true,
      });
    }
  } catch (e) {
    stopReason = input.signal.aborted ? 'aborted' : 'error';
    await emit({
      type: 'error',
      code: 'provider_error',
      title: 'The AI provider could not be reached',
      // Never the provider's own text: it echoes the Authorization header.
      retriable: true,
    });
  }

  const tokens = ctx.runState.tokens.input + ctx.runState.tokens.output;
  await appendAgentMessage(deps.pool, {
    conversationId: conversation,
    workspaceId: input.workspaceId,
    role: 'assistant',
    content: assistantText,
    toolCalls: ctx.runState.toolCalls,
    inputTokens: ctx.runState.tokens.input,
    outputTokens: ctx.runState.tokens.output,
    model: deps.ai.model,
    outcome: stopReason === 'error' ? 'provider_error' : stopReason === 'aborted' ? 'cancelled' : 'ok',
  });

  await emit({ type: 'done', turnId, stopReason, tokens });
  return { stopReason, tokens };
}

/** Argument values a chip may show. Mirrors the guard's own redaction. */
function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (/token|secret|password|key|credential/i.test(k) && k !== 'connectorKey') out[k] = '[redacted]';
    else if (typeof v === 'string' && v.length > 200) out[k] = `${v.slice(0, 60)}…`;
    else out[k] = v;
  }
  return out;
}

/**
 * The frames a tool's *result* implies, emitted here rather than inside the tool so the
 * agent package stays free of any transport concept.
 */
async function afterTool(
  deps: ChatTurnDeps,
  ctx: AgentRunContext,
  tool: string,
  args: Record<string, unknown>,
  out: Record<string, unknown>,
  emit: Emit,
): Promise<void> {
  if ((tool === 'put_draft' || tool === 'set_node_connection') && out['error'] === undefined) {
    const workflowId = String(args['workflowId'] ?? ctx.runState.createdWorkflowId ?? '');
    if (workflowId) {
      const draft = await getDraft(deps.pool, workflowId);
      if (draft) {
        await emit({ type: 'canvas', workflowId, revision: draft.revision, definition: draft.definition });
      }
    }
  }
  if (tool === 'request_credential' && out['error'] === undefined) {
    await emit({
      type: 'connection.required',
      connectorKey: String(out['connectorKey']),
      displayName: String(out['displayName']),
      nodeIds: args['nodeId'] ? [String(args['nodeId'])] : [],
      requestId: String(out['requestId']),
      formUrl: String(out['formUrl']),
    });
  }
}

export type { ChatFrame };
