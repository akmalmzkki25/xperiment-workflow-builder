import {
  createVersion,
  createWorkflow,
  getDraft,
  getWorkflow,
  listConnections,
  listWorkflows,
  updateDraft,
} from '@xperiment/db';
import { canonicalHash, validateWorkflow, type WorkflowIR } from '@xperiment/ir';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendProblem } from '../problem.js';
import type { ServerDeps } from './deps.js';

const createSchema = z.object({ name: z.string().min(1).max(200) }).strict();
const draftSchema = z.object({ definition: z.unknown() }).strict();
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export function registerWorkflowRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post('/v1/workflows', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const wf = await createWorkflow(deps.pool, { name: parsed.data.name });
    return reply.status(201).send(wf);
  });

  app.get('/v1/workflows', async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return sendProblem(reply, 400, 'Invalid query', q.error.message);
    return listWorkflows(deps.pool, { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) });
  });

  app.get('/v1/workflows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const draft = await getDraft(deps.pool, id);
    const versions = await deps.pool.query(
      `SELECT id, version_number, definition_hash, published_at FROM workflow_versions WHERE workflow_id = $1 ORDER BY version_number DESC`,
      [id],
    );
    return {
      ...wf,
      draft,
      versions: (versions.rows as Record<string, unknown>[]).map((v) => ({
        id: v['id'],
        versionNumber: Number(v['version_number']),
        definitionHash: v['definition_hash'],
        publishedAt: v['published_at'],
      })),
    };
  });

  app.put('/v1/workflows/:id/draft', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
      return sendProblem(reply, 428, 'If-Match header required', 'Send the current draft revision in If-Match');
    }
    const parsed = draftSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const revision = await updateDraft(deps.pool, {
      workflowId: id,
      definition: parsed.data.definition,
      expectedRevision: Number(ifMatch),
    });
    if (revision === null) {
      return sendProblem(reply, 412, 'Draft revision conflict', 'The draft was modified by someone else');
    }
    return { revision };
  });

  const workspaceConnections = async () =>
    (await listConnections(deps.pool)).map((c) => ({ id: c.id, connectorKey: c.connectorKey }));

  app.post('/v1/workflows/:id/validate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const draft = await getDraft(deps.pool, id);
    if (!draft) return sendProblem(reply, 404, 'Workflow not found');
    const result = validateWorkflow(draft.definition, {
      registry: deps.registry,
      connections: await workspaceConnections(),
    });
    return { valid: result.valid, findings: result.findings };
  });

  app.post('/v1/workflows/:id/publish', async (req, reply) => {
    const { id } = req.params as { id: string };
    const draft = await getDraft(deps.pool, id);
    if (!draft) return sendProblem(reply, 404, 'Workflow not found');
    const result = validateWorkflow(draft.definition, {
      registry: deps.registry,
      connections: await workspaceConnections(),
    });
    if (!result.valid || !result.ir) {
      return sendProblem(reply, 422, 'Draft failed validation', undefined, result.findings);
    }
    const hash = canonicalHash(result.ir as WorkflowIR);
    const version = await createVersion(deps.pool, { workflowId: id, definition: draft.definition, hash });
    return reply.status(201).send({ id: version.id, versionNumber: version.versionNumber, definitionHash: hash });
  });
}
