import { AGENT_TOOL_PERMISSIONS, type AgentToolId, type RequiredPermission } from '@xperiment/agent';
import {
  createAgentConversation,
  getAgentConversation,
  listAgentMessages,
  listOpenCredentialRequests,
  recordAiUsage,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runChatTurn } from '../ai/chatTurn.js';
import { encodeFrame, type ChatFrame } from '../ai/frames.js';
import { authOf, requirePermission } from '../auth/plugin.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';
import { quotaBlocks } from './plan.js';

/**
 * Typechecks only if every permission the agent asks for is a real Xperiment permission. A
 * tool inventing `workflow:god` is a compile error here rather than a runtime 500 — and
 * the agent package still does not import from this app, which would be a cycle.
 */
const AGENT_PERMISSIONS: Record<AgentToolId, Permission> = AGENT_TOOL_PERMISSIONS;

/** One live turn per workspace. See the concurrency note on the POST handler. */
const inFlight = new Set<string>();

const messageSchema = z.object({ message: z.string().min(1).max(4000) }).strict();
const createSchema = z.object({ workflowId: z.string().uuid().optional() }).strict();

export function registerAgentRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/agent/conversations', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const c = await createAgentConversation(deps.pool, {
      workspaceId: ctx.workspaceId,
      createdBy: ctx.userId ?? null,
      ...(parsed.data.workflowId ? { workflowId: parsed.data.workflowId } : {}),
    });
    return reply.status(201).send({ conversationId: c.id, workflowId: c.workflowId });
  });

  app.get('/v1/agent/conversations/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:read')) return;
    const { id } = req.params as { id: string };
    const c = await getAgentConversation(deps.pool, id, ctx.workspaceId);
    // Scoped by workspace, so a conversation started before a workspace switch is a 404
    // rather than another tenant's transcript.
    if (!c) return sendProblem(reply, 404, 'Conversation not found');
    return {
      conversationId: c.id,
      workflowId: c.workflowId,
      title: c.title,
      messages: await listAgentMessages(deps.pool, id, ctx.workspaceId),
      openCredentialRequests: await listOpenCredentialRequests(deps.pool, id, ctx.workspaceId),
    };
  });

  /**
   * One turn, streamed.
   *
   * Everything that can fail does so BEFORE the hijack: once `200 text/event-stream` is
   * on the wire there is no way to send a problem document. After that the only channel
   * for a failure is an `error` frame.
   */
  app.post('/v1/agent/conversations/:id/messages', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'aiTokensPerMonth')) return;
    if (!deps.ai.apiKey) {
      return sendProblem(reply, 503, 'AI is not configured', 'Set OPENROUTER_API_KEY to enable the AI builder');
    }
    const { id } = req.params as { id: string };
    const conversation = await getAgentConversation(deps.pool, id, ctx.workspaceId);
    if (!conversation) return sendProblem(reply, 404, 'Conversation not found');
    const parsed = messageSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);

    // The rate limiter counts requests, so one 90-second stream making a dozen model
    // calls counts as one. This is the cap that actually bounds spend.
    if (inFlight.has(ctx.workspaceId)) {
      return sendProblem(reply, 429, 'A turn is already running', 'Wait for the current reply to finish.');
    }

    const granted = new Set<RequiredPermission>(
      (Object.values(AGENT_PERMISSIONS) as Permission[])
        .filter((p) => hasPermission(ctx.role, p))
        .map((p) => p as RequiredPermission),
    );

    const history = (await listAgentMessages(deps.pool, id, ctx.workspaceId))
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    inFlight.add(ctx.workspaceId);
    const controller = new AbortController();
    reply.raw.on('close', () => controller.abort());

    reply.hijack();
    // Load-bearing: hijacking skips the onSend path, so headers set in hooks —
    // x-request-id and x-ratelimit-* — are silently dropped without this.
    const carried: Record<string, string> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (typeof v === 'string' || typeof v === 'number') carried[k] = String(v);
    }
    reply.raw.writeHead(200, {
      ...carried,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders();

    let seq = 0;
    const emit = async (frame: ChatFrame): Promise<void> => {
      seq += 1;
      const chunk = encodeFrame(seq, frame);
      // A canvas frame can be a couple of hundred kilobytes of IR; write() returns false
      // when the socket buffer fills, and ignoring that stalls large graphs.
      if (!reply.raw.write(chunk)) {
        await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
      }
    };
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    let tokens = 0;
    try {
      const result = await runChatTurn(
        {
          pool: deps.pool,
          registry: deps.registry,
          ai: { apiKey: deps.ai.apiKey, model: deps.ai.model, baseUrl: deps.ai.baseUrl },
          appUrl: deps.appUrl,
        },
        {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId ?? null,
          conversationId: id,
          history,
          prompt: parsed.data.message,
          grantedPermissions: granted,
          signal: controller.signal,
        },
        emit,
      );
      tokens = result.tokens;
    } catch (e) {
      await emit({
        type: 'error',
        code: 'turn_failed',
        title: 'That reply could not be finished',
        retriable: true,
      }).catch(() => undefined);
      req.log.warn({ err: (e as Error).message }, 'agent.turn_failed');
    } finally {
      clearInterval(ping);
      inFlight.delete(ctx.workspaceId);
      if (tokens > 0) {
        try {
          await recordAiUsage(deps.pool, {
            workspaceId: ctx.workspaceId,
            tokens,
            model: deps.ai.model,
            kind: 'chat',
          });
        } catch (e) {
          req.log.warn({ err: (e as Error).message }, 'usage.ai_record_failed');
        }
      }
      reply.raw.end();
    }
  });
}
