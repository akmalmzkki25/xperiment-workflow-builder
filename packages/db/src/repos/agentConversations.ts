import { type Db } from '../pool.js';
import { redactSecrets } from '../redact.js';

/**
 * Where a conversation with the workflow builder lives.
 *
 * Every read takes `workspaceId` as a required argument rather than deriving it from the
 * conversation row. The same reasoning as `getConnectionWithPayload`: requiring the
 * argument turns a whole class of omission into a compile error rather than something to
 * remember.
 */

export type AgentMessageRole = 'user' | 'assistant';
export type AgentMessageOutcome = 'ok' | 'provider_error' | 'quota_exceeded' | 'cancelled' | 'tool_limit' | 'refused';

export interface AgentConversationRow {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  workflowId: string | null;
  title: string;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageRow {
  /** BIGSERIAL: node-postgres returns int8 as a string, and it is the page cursor. */
  id: string;
  role: AgentMessageRole;
  content: string;
  toolCalls: unknown[];
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  outcome: AgentMessageOutcome;
  createdAt: string;
}

export interface CredentialRequestRow {
  id: string;
  connectorKey: string;
  nodeId: string | null;
  reason: string;
  fulfilledConnectionId: string | null;
  createdAt: string;
}

const ts = (v: unknown): string => (v instanceof Date ? v.toISOString() : (v as string));

function mapConversation(r: Record<string, unknown>): AgentConversationRow {
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    createdBy: (r['created_by'] as string | null) ?? null,
    workflowId: (r['workflow_id'] as string | null) ?? null,
    title: r['title'] as string,
    status: r['status'] as 'open' | 'closed',
    createdAt: ts(r['created_at']),
    updatedAt: ts(r['updated_at']),
  };
}

function mapMessage(r: Record<string, unknown>): AgentMessageRow {
  return {
    id: String(r['id']),
    role: r['role'] as AgentMessageRole,
    content: r['content'] as string,
    toolCalls: (r['tool_calls'] as unknown[]) ?? [],
    inputTokens: Number(r['input_tokens']),
    outputTokens: Number(r['output_tokens']),
    model: (r['model'] as string | null) ?? null,
    outcome: r['outcome'] as AgentMessageOutcome,
    createdAt: ts(r['created_at']),
  };
}

export async function createAgentConversation(
  db: Db,
  args: { workspaceId: string; createdBy: string | null; workflowId?: string; title?: string },
): Promise<AgentConversationRow> {
  const r = await db.query(
    `INSERT INTO agent_conversations (workspace_id, created_by, workflow_id, title)
     VALUES ($1,$2,$3,COALESCE($4,'Untitled')) RETURNING *`,
    [args.workspaceId, args.createdBy, args.workflowId ?? null, args.title ?? null],
  );
  return mapConversation(r.rows[0] as Record<string, unknown>);
}

export async function getAgentConversation(
  db: Db,
  id: string,
  workspaceId: string,
): Promise<AgentConversationRow | null> {
  const r = await db.query(`SELECT * FROM agent_conversations WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? mapConversation(row) : null;
}

export async function setConversationWorkflow(
  db: Db,
  id: string,
  workspaceId: string,
  workflowId: string,
): Promise<void> {
  await db.query(
    `UPDATE agent_conversations SET workflow_id = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId, workflowId],
  );
}

export interface AppendMessageInput {
  conversationId: string;
  workspaceId: string;
  role: AgentMessageRole;
  content: string;
  toolCalls?: unknown[];
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  outcome?: AgentMessageOutcome;
}

/**
 * Append one turn.
 *
 * Redaction happens HERE, not at the call site. A transcript that depends on every caller
 * remembering to redact is a transcript that will one day hold a bot token — and unlike
 * the other places `redactSecrets` is used, this one is written by a loop the author of a
 * new tool never sees.
 */
export async function appendAgentMessage(db: Db, input: AppendMessageInput): Promise<AgentMessageRow> {
  const redacted = redactSecrets(input.toolCalls ?? []) as unknown[];
  const r = await db.query(
    `INSERT INTO agent_messages
       (conversation_id, workspace_id, role, content, tool_calls, input_tokens, output_tokens, model, outcome)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,COALESCE($9,'ok')) RETURNING *`,
    [
      input.conversationId,
      input.workspaceId,
      input.role,
      input.content,
      JSON.stringify(redacted),
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.model ?? null,
      input.outcome ?? null,
    ],
  );
  await db.query(`UPDATE agent_conversations SET updated_at = now() WHERE id = $1`, [input.conversationId]);
  return mapMessage(r.rows[0] as Record<string, unknown>);
}

export async function listAgentMessages(
  db: Db,
  conversationId: string,
  workspaceId: string,
  limit = 200,
): Promise<AgentMessageRow[]> {
  const r = await db.query(
    // Ordered by id, not created_at: created_at is transaction start time, so a slow turn
    // can commit a row that sorts before one already visible.
    `SELECT * FROM agent_messages WHERE conversation_id = $1 AND workspace_id = $2 ORDER BY id LIMIT $3`,
    [conversationId, workspaceId, limit],
  );
  return (r.rows as Record<string, unknown>[]).map(mapMessage);
}

export async function createCredentialRequest(
  db: Db,
  args: { conversationId: string; workspaceId: string; connectorKey: string; nodeId?: string; reason: string },
): Promise<CredentialRequestRow> {
  const r = await db.query(
    `INSERT INTO agent_credential_requests (conversation_id, workspace_id, connector_key, node_id, reason)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [args.conversationId, args.workspaceId, args.connectorKey, args.nodeId ?? null, args.reason],
  );
  const row = r.rows[0] as Record<string, unknown>;
  return {
    id: row['id'] as string,
    connectorKey: row['connector_key'] as string,
    nodeId: (row['node_id'] as string | null) ?? null,
    reason: row['reason'] as string,
    fulfilledConnectionId: null,
    createdAt: ts(row['created_at']),
  };
}

export async function listOpenCredentialRequests(
  db: Db,
  conversationId: string,
  workspaceId: string,
): Promise<CredentialRequestRow[]> {
  const r = await db.query(
    `SELECT * FROM agent_credential_requests
     WHERE conversation_id = $1 AND workspace_id = $2 AND fulfilled_at IS NULL
     ORDER BY created_at`,
    [conversationId, workspaceId],
  );
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    id: row['id'] as string,
    connectorKey: row['connector_key'] as string,
    nodeId: (row['node_id'] as string | null) ?? null,
    reason: row['reason'] as string,
    fulfilledConnectionId: (row['fulfilled_connection_id'] as string | null) ?? null,
    createdAt: ts(row['created_at']),
  }));
}

export async function fulfilCredentialRequest(
  db: Db,
  id: string,
  workspaceId: string,
  connectionId: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE agent_credential_requests SET fulfilled_connection_id = $3, fulfilled_at = now()
     WHERE id = $1 AND workspace_id = $2 AND fulfilled_at IS NULL`,
    [id, workspaceId, connectionId],
  );
  return (r.rowCount ?? 0) > 0;
}
