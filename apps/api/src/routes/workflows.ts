import { randomBytes } from 'node:crypto';
import {
  clearWorkflowCallback,
  createVersion,
  createWorkflow,
  getDraft,
  getVersion,
  getWorkflow,
  listConnections,
  listWorkflows,
  setWorkflowCallback,
  updateDraft,
} from '@xperiment/db';
import { canonicalHash, diffWorkflows, validateWorkflow, workflowIrSchema, type WorkflowIR } from '@xperiment/ir';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({ name: z.string().min(1).max(200) }).strict();
const draftSchema = z.object({ definition: z.unknown() }).strict();
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export function registerWorkflowRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workflows', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const wf = await createWorkflow(deps.pool, { workspaceId: ctx.workspaceId, name: parsed.data.name });
    return reply.status(201).send(wf);
  });

  app.get('/v1/workflows', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:read')) return;
    const q = listQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return sendProblem(reply, 400, 'Invalid query', q.error.message);
    return listWorkflows(deps.pool, {
      workspaceId: ctx.workspaceId,
      limit: q.data.limit,
      ...(q.data.cursor ? { cursor: q.data.cursor } : {}),
    });
  });

  app.get('/v1/workflows/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:read')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
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
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
      return sendProblem(reply, 428, 'If-Match header required', 'Send the current draft revision in If-Match');
    }
    // `revision` is a bigint column, so a non-integer here reaches the driver and the
    // 22P02 surfaces as a 500 echoing its error text. RFC 7232 lets a conformant client
    // send the entity tag quoted or weak, and bare `Number('"1"')` is NaN — so strip the
    // ETag syntax first, then insist on an integer.
    const tag = ifMatch.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1');
    const expectedRevision = Number(tag);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return sendProblem(reply, 400, 'Invalid If-Match', 'If-Match must be the draft revision number');
    }
    const parsed = draftSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const revision = await updateDraft(deps.pool, {
      workflowId: id,
      definition: parsed.data.definition,
      expectedRevision,
    });
    if (revision === null) {
      return sendProblem(reply, 412, 'Draft revision conflict', 'The draft was modified by someone else');
    }
    return { revision };
  });

  const workspaceConnections = async (workspaceId: string) =>
    (await listConnections(deps.pool, workspaceId)).map((c) => ({ id: c.id, connectorKey: c.connectorKey }));

  app.post('/v1/workflows/:id/validate', async (req, reply) => {
    const ctx = authOf(req);
    // Read-shaped despite the verb: it inspects the draft and returns findings.
    if (!requirePermission(reply, ctx, 'workflow:read')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const draft = await getDraft(deps.pool, id);
    if (!draft) return sendProblem(reply, 404, 'Workflow not found');
    const result = validateWorkflow(draft.definition, {
      registry: deps.registry,
      connections: await workspaceConnections(ctx.workspaceId),
    });
    return { valid: result.valid, findings: result.findings };
  });

  const callbackSchema = z.object({ url: z.string().url() }).strict();

  app.put('/v1/workflows/:id/callback', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    const { id } = req.params as { id: string };
    if (!(await getWorkflow(deps.pool, id, ctx.workspaceId))) return sendProblem(reply, 404, 'Workflow not found');
    const parsed = callbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const secret = randomBytes(24).toString('base64url');
    const sealed = await deps.triggerVault.encrypt(ctx.workspaceId, secret);
    await setWorkflowCallback(deps.pool, {
      workflowId: id,
      url: parsed.data.url,
      secretEncrypted: sealed.blob,
      encVersion: sealed.encVersion,
    });
    // The signing secret is shown once, like a trigger secret.
    return { url: parsed.data.url, secret };
  });

  app.delete('/v1/workflows/:id/callback', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    const { id } = req.params as { id: string };
    if (!(await getWorkflow(deps.pool, id, ctx.workspaceId))) return sendProblem(reply, 404, 'Workflow not found');
    await clearWorkflowCallback(deps.pool, id);
    return reply.status(204).send();
  });

  app.post('/v1/workflows/:id/publish', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const draft = await getDraft(deps.pool, id);
    if (!draft) return sendProblem(reply, 404, 'Workflow not found');
    const result = validateWorkflow(draft.definition, {
      registry: deps.registry,
      connections: await workspaceConnections(ctx.workspaceId),
    });
    if (!result.valid || !result.ir) {
      return sendProblem(reply, 422, 'Draft failed validation', undefined, result.findings);
    }
    const hash = canonicalHash(result.ir as WorkflowIR);
    const version = await createVersion(deps.pool, { workflowId: id, definition: draft.definition, hash });
    return reply.status(201).send({ id: version.id, versionNumber: version.versionNumber, definitionHash: hash });
  });

  app.get('/v1/workflows/:id/diff', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:read')) return;
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as Record<string, unknown>;
    const from = q['from'];
    const to = q['to'];
    // Reject missing or repeated (?from=a&from=b → array) query params before they reach the DB.
    if (typeof from !== 'string' || typeof to !== 'string') {
      return sendProblem(reply, 400, 'Missing from/to', 'Both from and to must be a single value');
    }
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');

    const resolve = async (ref: string): Promise<{ label: string; ir: unknown } | { error: string }> => {
      if (ref === 'draft') {
        const draft = await getDraft(deps.pool, id);
        if (!draft) return { error: 'no_draft' };
        return { label: 'draft', ir: draft.definition };
      }
      if (!UUID_RE.test(ref)) return { error: 'foreign_version' }; // non-UUID would raise pg 22P02
      const v = await getVersion(deps.pool, ref);
      if (!v || v.workflowId !== id) return { error: 'foreign_version' };
      return { label: String(v.versionNumber), ir: v.definition };
    };
    const a = await resolve(from);
    if ('error' in a) return sendProblem(reply, 400, 'Invalid from', a.error);
    const b = await resolve(to);
    if ('error' in b) return sendProblem(reply, 400, 'Invalid to', b.error);
    // A draft (or any unvalidated definition) may not be a complete IR → clean 422, not a 500.
    const fromIr = workflowIrSchema.safeParse(a.ir);
    if (!fromIr.success) return sendProblem(reply, 422, 'from is not a valid workflow', 'The "from" side is not a complete workflow (e.g. an unpublished draft)');
    const toIr = workflowIrSchema.safeParse(b.ir);
    if (!toIr.success) return sendProblem(reply, 422, 'to is not a valid workflow', 'The "to" side is not a complete workflow (e.g. an unpublished draft)');
    return { from: a.label, to: b.label, diff: diffWorkflows(fromIr.data, toIr.data) };
  });

  app.post('/v1/workflows/:id/versions/:versionId/rollback', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'workflow:write')) return;
    const { id, versionId } = req.params as { id: string; versionId: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    if (!UUID_RE.test(versionId)) return sendProblem(reply, 404, 'Version not found'); // avoid a pg 22P02 500
    const version = await getVersion(deps.pool, versionId);
    if (!version || version.workflowId !== id) return sendProblem(reply, 404, 'Version not found');
    const created = await createVersion(deps.pool, {
      workflowId: id,
      definition: version.definition,
      hash: version.definitionHash,
    });
    return reply.status(201).send({ ...created, rolledBackFrom: version.versionNumber });
  });
}
