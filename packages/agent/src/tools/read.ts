import { connectorCatalog, CREDENTIAL_GUIDES, type ConnectorCatalogItem, type ConnectorKey } from '@xperiment/connectors';
import { getDraft, getWorkflow, listConnections, listWorkflows } from '@xperiment/db';
import { z } from 'zod';
import type { XperimentToolSpec } from '../defineTool.js';

/**
 * The tools that only read.
 *
 * None of their input schemas has a field capable of naming a workspace. Every one of
 * them closes over `ctx.workspaceId`, which came from `authOf(req)` — so a cross-tenant
 * read is not something the model is trusted not to attempt, it is something it has no
 * vocabulary to express.
 */

/**
 * Cross-field rules a JSON Schema cannot state, keyed by node type.
 *
 * These used to live as prose in one paragraph of the system prompt, where they applied
 * to every generation whether or not the node was in play. Attached to the node, they
 * arrive exactly when the model is about to use it.
 */
const AUTHORING_NOTES: Record<string, string[]> = {
  'whatsapp.sendMessage': ['Takes exactly one of text or templateName, never both.'],
  'email.send': ['Needs text or html.'],
  'core.switch': ['Every case needs an explicit "equals".'],
  'core.aggregate': ['Must not be given a field when the operation is count.'],
  'core.filter': ['Point items at upstream output with an expression, even though the schema marks it optional.'],
  'core.sort': ['Point items at upstream output with an expression.'],
  'core.limit': ['Point items at upstream output with an expression.'],
  'core.splitBatch': ['Point items at upstream output with an expression.'],
  'core.loop': [
    'Point items at upstream output with an expression.',
    'Its body runs at most 100 iterations by default; a longer list needs the limit raised deliberately.',
  ],
  'core.stopAndError': ['Has no output ports at all. Nothing may be wired downstream of it.'],
  'schedule.trigger': ['cron is a five-field expression. timezone defaults to Asia/Jakarta.'],
  'telegram.sendMessage': ['chatId is a number as a string, and it is NOT part of the telegram connection.'],
};

let cachedCatalog: ConnectorCatalogItem[] | null = null;
function catalogOf(registry: Parameters<typeof connectorCatalog>[0]): ConnectorCatalogItem[] {
  // The registry is fixed for the process lifetime, as `routes/connectors.ts` already
  // assumes by snapshotting at registration time.
  cachedCatalog ??= connectorCatalog(registry);
  return cachedCatalog;
}

/** Cheap edit distance over the type list, so a wrong guess gets corrected once. */
function nearest(types: readonly string[], wanted: string): string[] {
  const w = wanted.toLowerCase();
  return types
    .filter((t) => {
      const l = t.toLowerCase();
      return l.startsWith(w.split('.')[0] ?? '') || l.includes(w.slice(0, 6)) || w.includes(l);
    })
    .slice(0, 4);
}

export const describeNodeType: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'describe_node_type',
  description:
    'Get the exact parameters, output ports and operationVersion for one node type. Call this for every node type before you use it.',
  permission: 'workflow:read',
  mutates: false,
  inputSchema: z.object({ type: z.string().min(1) }).strict(),
  outputSchema: z.unknown(),
  async run(input: { type: string }, ctx) {
    const catalog = catalogOf(ctx.registry);
    const found = catalog.find((c) => c.type === input.type);
    if (!found) {
      return {
        error: 'unknown_node_type',
        message: `There is no node type called ${input.type}. Use one from the list in your instructions.`,
        didYouMean: nearest(
          catalog.map((c) => c.type),
          input.type,
        ),
      };
    }
    return {
      type: found.type,
      kind: found.kind,
      operationVersion: found.operationVersion,
      displayName: found.displayName ?? found.type,
      description: found.description ?? '',
      category: found.category ?? '',
      outputPorts: found.outputPorts,
      ...(found.requiresConnection ? { requiresConnection: found.requiresConnection } : {}),
      paramsJsonSchema: found.paramsJsonSchema,
      authoringNotes: AUTHORING_NOTES[found.type] ?? [],
    };
  },
};

export const getCredentialGuide: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'get_credential_guide',
  description:
    'Explain step by step how the user obtains the credential a connector needs — for example a Telegram bot token from BotFather.',
  permission: 'workflow:read',
  mutates: false,
  inputSchema: z.object({ connectorKey: z.string().min(1) }).strict(),
  outputSchema: z.unknown(),
  async run(input: { connectorKey: string }) {
    const guide = CREDENTIAL_GUIDES[input.connectorKey as ConnectorKey];
    if (!guide) {
      return {
        error: 'unknown_connector',
        message: `Xperiment has no connector called ${input.connectorKey}.`,
        known: Object.keys(CREDENTIAL_GUIDES),
      };
    }
    return { connectorKey: input.connectorKey, ...guide };
  },
};

export const listConnectionsTool: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'list_connections',
  description: 'List the credentials this workspace already has, so you can wire a node to one. Never returns a secret.',
  permission: 'connection:read',
  mutates: false,
  inputSchema: z.object({ connectorKey: z.string().optional() }).strict(),
  outputSchema: z.unknown(),
  async run(input: { connectorKey?: string }, ctx) {
    const rows = await listConnections(ctx.pool, ctx.workspaceId);
    const items = rows
      .filter((c) => input.connectorKey === undefined || c.connectorKey === input.connectorKey)
      // Field by field, not a spread: the row type could gain a column, and a spread
      // would carry it to the model without anybody deciding to.
      .map((c) => ({ id: c.id, connectorKey: c.connectorKey, name: c.name, status: c.status }));
    return { items };
  },
};

export const listWorkflowsTool: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'list_workflows',
  description: 'Find an existing workflow by name, when the user refers to one they already have.',
  permission: 'workflow:read',
  mutates: false,
  inputSchema: z
    .object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).default(10) })
    .strict(),
  outputSchema: z.unknown(),
  async run(input: { query?: string; limit?: number }, ctx) {
    const { items } = await listWorkflows(ctx.pool, { workspaceId: ctx.workspaceId, limit: 100 });
    const q = input.query?.toLowerCase();
    const matched = (q ? items.filter((w) => w.name.toLowerCase().includes(q)) : items).slice(0, input.limit ?? 10);
    return {
      items: matched.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        active: w.active,
        draftRevision: w.draftRevision,
      })),
    };
  },
};

export const getWorkflowTool: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'get_workflow',
  description: "Read a workflow's current draft definition.",
  permission: 'workflow:read',
  mutates: false,
  inputSchema: z.object({ workflowId: z.string().uuid() }).strict(),
  outputSchema: z.unknown(),
  async run(input: { workflowId: string }, ctx) {
    // The two-argument form. A UUID from another workspace returns null here rather than
    // a row, which is what makes the tenancy structural instead of remembered.
    const wf = await getWorkflow(ctx.pool, input.workflowId, ctx.workspaceId);
    if (!wf) return { error: 'not_found', message: 'No workflow with that id in this workspace.' };
    const draft = await getDraft(ctx.pool, input.workflowId);
    return {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      active: wf.active,
      draftRevision: draft?.revision ?? wf.draftRevision,
      definition: draft?.definition ?? null,
    };
  },
};

export const READ_TOOLS = [
  describeNodeType,
  getCredentialGuide,
  listConnectionsTool,
  listWorkflowsTool,
  getWorkflowTool,
] as const;
