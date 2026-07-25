import { createWorkflow, updateDraft } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, roleGate } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import { getTemplate, listTemplates, type WorkflowTemplate } from '../templates/catalog.js';
import type { ResolvedServerDeps } from './deps.js';

function summarize(t: WorkflowTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    useCase: t.useCase,
    version: t.version,
    requiredConnectors: t.requiredConnectors,
  };
}

const cloneSchema = z.object({ name: z.string().min(1).max(120).optional() }).strict();

export function registerTemplateRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/templates', async (req) => {
    const category = (req.query as { category?: string }).category;
    return { items: listTemplates(typeof category === 'string' ? category : undefined).map(summarize) };
  });

  app.get('/v1/templates/:id', async (req, reply) => {
    const t = getTemplate((req.params as { id: string }).id);
    if (!t) return sendProblem(reply, 404, 'Template not found');
    return t;
  });

  app.post('/v1/templates/:id/clone', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const t = getTemplate((req.params as { id: string }).id);
    if (!t) return sendProblem(reply, 404, 'Template not found');
    const parsed = cloneSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid body', parsed.error.message);
    const wf = await createWorkflow(deps.pool, { workspaceId: ctx.workspaceId, name: parsed.data.name ?? t.name });
    await updateDraft(deps.pool, { workflowId: wf.id, definition: t.definition, expectedRevision: 1 });
    return reply.status(201).send({ id: wf.id, name: wf.name });
  });
}
