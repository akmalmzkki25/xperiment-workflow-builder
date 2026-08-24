import { generateWorkflow, type CatalogEntry, type ChatClient } from '@xperiment/ai';
import { connectorCatalog } from '@xperiment/connectors';
import { listConnections, recordAiUsage } from '@xperiment/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { quotaBlocks } from './plan.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

/**
 * Whole-run budget. The client's own per-call timeout bounds one round trip; three
 * repair attempts against a slow provider would otherwise add up to three of them in
 * series, with nothing above watching the clock.
 */
const RUN_BUDGET_MS = 90_000;

const generateSchema = z.object({ prompt: z.string().min(1).max(4000) }).strict();
const editSchema = z.object({ prompt: z.string().min(1).max(4000), definition: z.unknown() }).strict();

export function registerAiRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  const catalog = connectorCatalog(deps.registry) as CatalogEntry[];

  /**
   * Produces the answer without sending it, so the bill can be settled first. Returning a
   * descriptor rather than writing to the reply is the whole point: metering after the
   * response has flushed is a race the caller can win, and the caller winning it is
   * exactly the abuse this route needed to stop.
   */
  type AiOutcome =
    | { kind: 'problem'; status: number; title: string; detail: string }
    | { kind: 'body'; status: number; body: Record<string, unknown> };

  async function handle(
    workspaceId: string,
    prompt: string,
    spend: { tokens: number },
    currentIr?: unknown,
  ): Promise<AiOutcome> {
    if (!deps.ai.apiKey) {
      return {
        kind: 'problem',
        status: 503,
        title: 'AI is not configured',
        detail: 'Set OPENROUTER_API_KEY to enable the AI builder',
      };
    }
    const client = deps.aiClientFactory({
      apiKey: deps.ai.apiKey,
      model: deps.ai.model,
      baseUrl: deps.ai.baseUrl,
      ...(deps.ai.appUrl ? { appUrl: deps.ai.appUrl } : {}),
    });
    /**
     * Count at the transport, not at the outcome.
     *
     * `generateWorkflow` returns `tokensUsed` only when it returns at all — a provider
     * error on the third attempt throws and takes the first two attempts' tokens with it,
     * and the 422 path used to return before anything was recorded. Both were spent. A
     * decorator counts the instant the provider answers, so no exit path can lose them.
     */
    const metered: ChatClient = {
      async chat(messages, opts) {
        const res = await client.chat(messages, opts);
        spend.tokens += res.usage.totalTokens;
        return res;
      },
    };
    const connections = (await listConnections(deps.pool, workspaceId)).map((c) => ({
      id: c.id,
      connectorKey: c.connectorKey,
      name: c.name,
    }));
    let result;
    try {
      result = await generateWorkflow(
        prompt,
        { client: metered, registry: deps.registry, catalog, connections, deadlineAt: Date.now() + RUN_BUDGET_MS },
        currentIr,
      );
    } catch {
      // AiProviderError etc. — never surface provider text (may echo the key).
      return {
        kind: 'problem',
        status: 502,
        title: 'AI provider error',
        detail: 'The AI provider could not be reached',
      };
    }
    if (!result.ir) {
      const detail = result.findings
        .slice(0, 3)
        .map((f) => (f.nodeId ? `${f.nodeId}: ${f.message}` : f.message))
        .join('; ');
      return {
        kind: 'body',
        status: 422,
        body: {
          title: 'AI could not produce a valid workflow',
          detail: detail || `Gave up after ${result.attempts} attempts`,
          findings: result.findings,
          attempts: result.attempts,
        },
      };
    }
    return { kind: 'body', status: 200, body: { ir: result.ir, attempts: result.attempts } };
  }

  /**
   * `handle` above owns the response; this owns the bill. Separated because every one of
   * `handle`'s exits — 200, 422, and the 502 it returns after swallowing a throw — has
   * already cost the same tokens, and the old code recorded on exactly one of them.
   */
  async function handleAndMeter(
    reply: FastifyReply,
    workspaceId: string,
    kind: 'generate' | 'edit',
    prompt: string,
    currentIr?: unknown,
  ): Promise<void> {
    const spend = { tokens: 0 };
    let outcome: AiOutcome;
    try {
      outcome = await handle(workspaceId, prompt, spend, currentIr);
    } finally {
      // Zero means no provider call ever answered, and a zero row would be a lie about
      // what was consumed. `recordAiUsage` skips it anyway; this says so out loud.
      if (spend.tokens > 0) {
        try {
          await recordAiUsage(deps.pool, { workspaceId, tokens: spend.tokens, model: deps.ai.model, kind });
        } catch (e) {
          // Best-effort: a metering write must never fail the user's generation.
          reply.log.warn({ err: (e as Error).message }, 'usage.ai_record_failed');
        }
      }
    }
    if (outcome.kind === 'problem') return sendProblem(reply, outcome.status, outcome.title, outcome.detail);
    return reply.status(outcome.status).send(outcome.body);
  }

  app.post('/v1/ai/generate', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'aiTokensPerMonth')) return;
    const parsed = generateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    return handleAndMeter(reply, ctx.workspaceId, 'generate', parsed.data.prompt);
  });

  app.post('/v1/ai/edit', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    if (await quotaBlocks(deps.pool, reply, ctx.workspaceId, 'aiTokensPerMonth')) return;
    const parsed = editSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    return handleAndMeter(reply, ctx.workspaceId, 'edit', parsed.data.prompt, parsed.data.definition);
  });
}
