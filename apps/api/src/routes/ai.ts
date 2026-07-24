import { generateWorkflow, type CatalogEntry } from '@xperiment/ai';
import { connectorCatalog } from '@xperiment/connectors';
import { listConnections } from '@xperiment/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authOf, roleGate } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const generateSchema = z.object({ prompt: z.string().min(1).max(4000) }).strict();
const editSchema = z.object({ prompt: z.string().min(1).max(4000), definition: z.unknown() }).strict();

export function registerAiRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  const catalog = connectorCatalog(deps.registry) as CatalogEntry[];

  async function handle(
    reply: FastifyReply,
    workspaceId: string,
    prompt: string,
    currentIr?: unknown,
  ): Promise<void> {
    if (!deps.ai.apiKey) {
      return sendProblem(reply, 503, 'AI is not configured', 'Set OPENROUTER_API_KEY to enable the AI builder');
    }
    const client = deps.aiClientFactory({
      apiKey: deps.ai.apiKey,
      model: deps.ai.model,
      baseUrl: deps.ai.baseUrl,
      ...(deps.ai.appUrl ? { appUrl: deps.ai.appUrl } : {}),
    });
    const connections = (await listConnections(deps.pool, workspaceId)).map((c) => ({
      id: c.id,
      connectorKey: c.connectorKey,
      name: c.name,
    }));
    let result;
    try {
      result = await generateWorkflow(prompt, { client, registry: deps.registry, catalog, connections }, currentIr);
    } catch {
      // AiProviderError etc. — never surface provider text (may echo the key).
      return sendProblem(reply, 502, 'AI provider error', 'The AI provider could not be reached');
    }
    if (!result.ir) {
      return reply.status(422).send({
        title: 'AI could not produce a valid workflow',
        findings: result.findings,
        attempts: result.attempts,
      });
    }
    return reply.status(200).send({ ir: result.ir, attempts: result.attempts });
  }

  app.post('/v1/ai/generate', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const parsed = generateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    return handle(reply, ctx.workspaceId, parsed.data.prompt);
  });

  app.post('/v1/ai/edit', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const parsed = editSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    return handle(reply, ctx.workspaceId, parsed.data.prompt, parsed.data.definition);
  });
}
