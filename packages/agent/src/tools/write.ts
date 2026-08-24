import { CREDENTIAL_GUIDES, type ConnectorKey } from '@xperiment/connectors';
import {
  createAgentConversation,
  createCredentialRequest,
  createWorkflow,
  getDraft,
  getWorkflow,
  listConnections,
  updateDraft,
} from '@xperiment/db';
import { requiredConnections, validateWorkflow, workflowIrSchema, type WorkflowIR } from '@xperiment/ir';
import { z } from 'zod';
import type { AgentRunContext, XperimentToolSpec, ToolError } from '../defineTool.js';

/**
 * The tools that change something.
 *
 * All five write only inside `ctx.workspaceId`, and none of them takes an id the model
 * invented for a tenant. `create_workflow` is idempotent within a turn, `put_draft`
 * always validates and always reports, and `request_credential` creates nothing at all.
 */

/**
 * `definition` arrives as a JSON string rather than as `workflowIrSchema`.
 *
 * Measured during the spike: the schema converts to a tidy 2,642 bytes, but
 * `node.parameters` becomes `{"type":"object","additionalProperties":{}}` — an open
 * record, and it has to be open, because parameters differ per connector. Strict tool
 * schemas reject that, and OPENROUTER_MODEL is user-configurable, so the provider that
 * will actually run this cannot be tested from here. A string parsed server-side against
 * the same schema gives the identical guarantee on every provider.
 */
type ParseOutcome = { ok: true; ir: WorkflowIR } | { ok: false; err: ToolError };

function parseDefinition(text: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, err: { error: 'not_json', message: 'definition must be a JSON string containing the workflow document.' } };
  }
  const parsed = workflowIrSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      err: {
        error: 'not_a_workflow',
        message: 'That JSON is not a workflow document.',
        detail: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    };
  }
  return { ok: true, ir: parsed.data as unknown as WorkflowIR };
}

async function workspaceConnections(ctx: AgentRunContext): Promise<{ id: string; connectorKey: string }[]> {
  return (await listConnections(ctx.pool, ctx.workspaceId)).map((c) => ({ id: c.id, connectorKey: c.connectorKey }));
}

export interface MissingConnection {
  nodeId: string;
  connectorKey: string;
  connectorDisplayName: string;
  /** Ids of connections of that connector the workspace already has. */
  existingConnectionIds: string[];
}

/**
 * Which nodes still need wiring, derived from the registry rather than from anything the
 * model said. This is what makes "tell the user what is missing" structural instead of
 * prompt-dependent — the same mechanism the workflow importer uses.
 */
function missingConnectionsFor(
  ir: WorkflowIR,
  ctx: AgentRunContext,
  connections: readonly { id: string; connectorKey: string }[],
): MissingConnection[] {
  const byId = new Map(connections.map((c) => [c.id, c.connectorKey]));
  return requiredConnections(ir, ctx.registry)
    .filter((r) => {
      const node = ir.nodes.find((n) => n.id === r.nodeId);
      const ref = node?.connectionRef;
      return ref === undefined || byId.get(ref) !== r.connectorKey;
    })
    .map((r) => ({
      nodeId: r.nodeId,
      connectorKey: r.connectorKey,
      connectorDisplayName: CREDENTIAL_GUIDES[r.connectorKey as ConnectorKey]?.displayName ?? r.connectorKey,
      existingConnectionIds: connections.filter((c) => c.connectorKey === r.connectorKey).map((c) => c.id),
    }));
}

async function validateStored(
  ctx: AgentRunContext,
  ir: WorkflowIR,
): Promise<{ valid: boolean; findings: unknown[]; missingConnections: MissingConnection[] }> {
  const connections = await workspaceConnections(ctx);
  const result = validateWorkflow(ir, { registry: ctx.registry, connections });
  return {
    valid: result.valid,
    findings: result.findings,
    missingConnections: missingConnectionsFor(ir, ctx, connections),
  };
}

export const createWorkflowTool: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'create_workflow',
  description: 'Create a new empty workflow and get its id. Use this once, at the start of a new build.',
  permission: 'workflow:write',
  mutates: true,
  inputSchema: z.object({ name: z.string().min(1).max(200) }).strict(),
  outputSchema: z.unknown(),
  async run(input: { name: string }, ctx) {
    if (ctx.runState.createdWorkflowId) {
      // Hand back the id rather than making a second one. A model that loses track of
      // what it created otherwise litters the workspace with empty workflows.
      return {
        error: 'already_created',
        workflowId: ctx.runState.createdWorkflowId,
        message: 'You already created a workflow this turn. Use that id.',
      };
    }
    const wf = await createWorkflow(ctx.pool, { workspaceId: ctx.workspaceId, name: input.name });
    ctx.runState.createdWorkflowId = wf.id;
    if (ctx.conversationId) {
      await ctx.pool.query(`UPDATE agent_conversations SET workflow_id = $2 WHERE id = $1`, [ctx.conversationId, wf.id]);
    }
    return { workflowId: wf.id, name: wf.name, draftRevision: 1 };
  },
};

export const putDraft: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'put_draft',
  description:
    'Save the complete workflow definition as the draft, as a JSON string. It is validated on the way in and the findings come back. A draft may be saved while still incomplete.',
  permission: 'workflow:write',
  mutates: true,
  inputSchema: z
    .object({
      workflowId: z.string().uuid(),
      definition: z.string().min(2),
      /** Optional: normally the tool reads the current revision itself. */
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  outputSchema: z.unknown(),
  async run(input: { workflowId: string; definition: string; expectedRevision?: number }, ctx) {
    if (!(await getWorkflow(ctx.pool, input.workflowId, ctx.workspaceId))) {
      return { error: 'not_found', message: 'No workflow with that id in this workspace.' };
    }
    const parsed = parseDefinition(input.definition);
    if (!parsed.ok) return parsed.err;

    // A revision is a concurrency token, not a decision, so the model is never asked for
    // one. Reading it here keeps 412 semantics without ever exposing them.
    const current = await getDraft(ctx.pool, input.workflowId);
    const expected = input.expectedRevision ?? current?.revision ?? 1;
    const revision = await updateDraft(ctx.pool, {
      workflowId: input.workflowId,
      definition: parsed.ir,
      expectedRevision: expected,
    });
    if (revision === null) {
      return {
        error: 'revision_conflict',
        message: 'Somebody edited this workflow while you were working. Call get_workflow and try once more.',
      };
    }

    // Always validate, always report. An agent claiming "done" over an invalid draft is
    // precisely the failure this whole feature exists to remove.
    const checked = await validateStored(ctx, parsed.ir);
    return { revision, ...checked };
  },
};

export const setNodeConnection: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'set_node_connection',
  description: "Point one node at one of the workspace's existing connections.",
  permission: 'workflow:write',
  mutates: true,
  inputSchema: z
    .object({ workflowId: z.string().uuid(), nodeId: z.string().min(1), connectionId: z.string().uuid() })
    .strict(),
  outputSchema: z.unknown(),
  async run(input: { workflowId: string; nodeId: string; connectionId: string }, ctx) {
    if (!(await getWorkflow(ctx.pool, input.workflowId, ctx.workspaceId))) {
      return { error: 'not_found', message: 'No workflow with that id in this workspace.' };
    }
    const draft = await getDraft(ctx.pool, input.workflowId);
    const parsed = workflowIrSchema.safeParse(draft?.definition);
    if (!parsed.success) {
      return { error: 'not_a_workflow', message: 'The saved draft is not a complete workflow yet. Call put_draft first.' };
    }
    const ir = parsed.data as WorkflowIR;
    const node = ir.nodes.find((n) => n.id === input.nodeId);
    if (!node) return { error: 'unknown_node', message: `No node called ${input.nodeId} in this workflow.` };

    const expects = ctx.registry.get(node.type)?.requiresConnection;
    if (!expects) {
      return {
        error: 'node_needs_no_connection',
        message: `${node.type} does not take a connection. Leave it alone.`,
      };
    }
    // Workspace-scoped, so a cross-tenant UUID is not_found rather than a wiring.
    const connections = await workspaceConnections(ctx);
    const found = connections.find((c) => c.id === input.connectionId);
    if (!found) return { error: 'not_found', message: 'No connection with that id in this workspace.' };
    if (found.connectorKey !== expects) {
      // The only place a connectionRef is written is a function that checks the connector
      // key, so a telegram node can never silently adopt a slack credential.
      return {
        error: 'connection_wrong_type',
        expected: expects,
        actual: found.connectorKey,
        message: `That connection is for ${found.connectorKey}, but ${node.type} needs ${expects}.`,
      };
    }

    const nodes = ir.nodes.map((n) => (n.id === input.nodeId ? { ...n, connectionRef: input.connectionId } : n));
    const next = { ...ir, nodes };
    const revision = await updateDraft(ctx.pool, {
      workflowId: input.workflowId,
      definition: next,
      expectedRevision: draft?.revision ?? 1,
    });
    if (revision === null) {
      return { error: 'revision_conflict', message: 'Somebody edited this workflow while you were working.' };
    }
    const checked = await validateStored(ctx, next as WorkflowIR);
    return { ok: true, revision, valid: checked.valid, findings: checked.findings };
  },
};

export const validateWorkflowTool: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'validate_workflow',
  description: 'Check the saved draft against every rule the publish gate uses, and get back what is wrong.',
  permission: 'workflow:read',
  mutates: false,
  inputSchema: z.object({ workflowId: z.string().uuid() }).strict(),
  outputSchema: z.unknown(),
  async run(input: { workflowId: string }, ctx) {
    if (!(await getWorkflow(ctx.pool, input.workflowId, ctx.workspaceId))) {
      return { error: 'not_found', message: 'No workflow with that id in this workspace.' };
    }
    const draft = await getDraft(ctx.pool, input.workflowId);
    // Validates what is STORED, not what was passed in, so there is one truth and no way
    // to check one document and have saved another.
    const parsed = workflowIrSchema.safeParse(draft?.definition);
    if (!parsed.success) {
      return { valid: false, findings: [{ layer: 'schema', code: 'incomplete_draft', message: 'The draft is not a complete workflow yet.' }], missingConnections: [] };
    }
    return validateStored(ctx, parsed.data as unknown as WorkflowIR);
  },
};

export const requestCredential: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'request_credential',
  description:
    "Ask the user to add a credential. This opens Xperiment's encrypted connection form. Never ask for a secret in the chat.",
  permission: 'connection:write',
  mutates: true,
  // No field here can hold a secret, and a test asserts it. A schema with a `token`
  // property would be an invitation to put one in the transcript.
  inputSchema: z
    .object({
      connectorKey: z.string().min(1),
      reason: z.string().min(1).max(300),
      nodeId: z.string().min(1).optional(),
    })
    .strict(),
  outputSchema: z.unknown(),
  async run(input: { connectorKey: string; reason: string; nodeId?: string }, ctx) {
    const guide = CREDENTIAL_GUIDES[input.connectorKey as ConnectorKey];
    if (!guide) return { error: 'unknown_connector', message: `Xperiment has no connector called ${input.connectorKey}.` };

    let conversationId = ctx.conversationId;
    if (!conversationId) {
      const c = await createAgentConversation(ctx.pool, { workspaceId: ctx.workspaceId, createdBy: ctx.userId });
      conversationId = c.id;
    }
    const req = await createCredentialRequest(ctx.pool, {
      conversationId,
      workspaceId: ctx.workspaceId,
      connectorKey: input.connectorKey,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      reason: input.reason,
    });
    ctx.runState.credentialRequests.push(req.id);
    const base = ctx.appUrl ?? '';
    return {
      requestId: req.id,
      connectorKey: input.connectorKey,
      displayName: guide.displayName,
      formUrl: `${base}/connections?connector=${encodeURIComponent(input.connectorKey)}&request=${req.id}`,
      guide,
    };
  },
};

export const WRITE_TOOLS = [
  createWorkflowTool,
  putDraft,
  setNodeConnection,
  validateWorkflowTool,
  requestCredential,
] as const;
