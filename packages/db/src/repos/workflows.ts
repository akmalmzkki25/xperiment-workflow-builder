import type pg from 'pg';
import { type Db } from '../pool.js';
import { insertOutbox } from './outbox.js';
import { withTx } from '../tx.js';

export interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  activeVersionId: string | null;
  draftRevision: number;
  active: boolean;
}

function mapWorkflow(r: Record<string, unknown>): WorkflowRow {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    status: r['status'] as string,
    activeVersionId: (r['active_version_id'] as string | null) ?? null,
    draftRevision: Number(r['draft_revision']),
    active: Boolean(r['active']),
  };
}

export async function createWorkflow(
  db: Db,
  args: { workspaceId: string; name: string },
): Promise<WorkflowRow> {
  const wf = await db.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1, $2) RETURNING *`, [
    args.workspaceId,
    args.name,
  ]);
  const row = wf.rows[0] as Record<string, unknown>;
  await db.query(
    `INSERT INTO workflow_drafts (workflow_id, workspace_id, definition_json, revision) VALUES ($1, $2, '{}'::jsonb, 1)`,
    [row['id'], args.workspaceId],
  );
  return mapWorkflow(row);
}

export async function getWorkflow(db: Db, id: string, workspaceId?: string): Promise<WorkflowRow | null> {
  const r = workspaceId
    ? await db.query(`SELECT * FROM workflows WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
    : await db.query(`SELECT * FROM workflows WHERE id = $1`, [id]);
  return r.rowCount ? mapWorkflow(r.rows[0] as Record<string, unknown>) : null;
}

export async function listWorkflows(
  db: Db,
  args: { workspaceId: string; limit: number; cursor?: string },
): Promise<{ items: WorkflowRow[]; nextCursor: string | null }> {
  const params: unknown[] = [args.workspaceId];
  let where = `WHERE workspace_id = $1`;
  if (args.cursor) {
    const [createdAt, id] = Buffer.from(args.cursor, 'base64').toString('utf8').split('|');
    params.push(createdAt, id);
    where += ` AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(args.limit + 1);
  const r = await db.query(
    `SELECT * FROM workflows ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows as Record<string, unknown>[];
  const hasMore = rows.length > args.limit;
  const items = rows.slice(0, args.limit);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(`${(last['created_at'] as Date).toISOString()}|${last['id'] as string}`).toString('base64')
      : null;
  return { items: items.map(mapWorkflow), nextCursor };
}

export async function getDraft(
  db: Db,
  workflowId: string,
): Promise<{ definition: unknown; revision: number } | null> {
  const r = await db.query(`SELECT definition_json, revision FROM workflow_drafts WHERE workflow_id = $1`, [
    workflowId,
  ]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as { definition_json: unknown; revision: string | number };
  return { definition: row.definition_json, revision: Number(row.revision) };
}

export async function updateDraft(
  db: Db,
  args: { workflowId: string; definition: unknown; expectedRevision: number },
): Promise<number | null> {
  const r = await db.query(
    `UPDATE workflow_drafts SET definition_json = $1, revision = revision + 1, updated_at = now()
     WHERE workflow_id = $2 AND revision = $3 RETURNING revision`,
    [JSON.stringify(args.definition), args.workflowId, args.expectedRevision],
  );
  if (!r.rowCount) return null;
  const revision = Number((r.rows[0] as { revision: string | number }).revision);
  await db.query(`UPDATE workflows SET draft_revision = $1, updated_at = now() WHERE id = $2`, [
    revision,
    args.workflowId,
  ]);
  return revision;
}

export async function createVersion(
  pool: pg.Pool,
  args: { workflowId: string; definition: unknown; hash: string },
): Promise<{ id: string; versionNumber: number }> {
  return withTx(pool, async (client) => {
    await client.query(`SELECT id FROM workflows WHERE id = $1 FOR UPDATE`, [args.workflowId]);
    const next = await client.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM workflow_versions WHERE workflow_id = $1`,
      [args.workflowId],
    );
    const versionNumber = Number((next.rows[0] as { n: string | number }).n);
    const inserted = await client.query(
      `INSERT INTO workflow_versions (workspace_id, workflow_id, version_number, definition_json, definition_hash)
       SELECT w.workspace_id, w.id, $2, $3, $4 FROM workflows w WHERE w.id = $1 RETURNING id`,
      [args.workflowId, versionNumber, JSON.stringify(args.definition), args.hash],
    );
    const id = (inserted.rows[0] as { id: string }).id;
    await client.query(
      `UPDATE workflows SET active_version_id = $1, status = 'published', updated_at = now() WHERE id = $2`,
      [id, args.workflowId],
    );
    return { id, versionNumber };
  });
}

export async function setWorkflowCallback(
  db: Db,
  args: { workflowId: string; url: string; secretEncrypted: Buffer },
): Promise<void> {
  await db.query(
    `UPDATE workflows SET completion_webhook_url = $1, completion_webhook_secret_encrypted = $2, updated_at = now()
     WHERE id = $3`,
    [args.url, args.secretEncrypted, args.workflowId],
  );
}

export async function clearWorkflowCallback(db: Db, workflowId: string): Promise<void> {
  await db.query(
    `UPDATE workflows SET completion_webhook_url = NULL, completion_webhook_secret_encrypted = NULL, updated_at = now()
     WHERE id = $1`,
    [workflowId],
  );
}

export async function getWorkflowCallback(
  db: Db,
  workflowId: string,
): Promise<{ url: string; secretEncrypted: Buffer } | null> {
  const r = await db.query(
    `SELECT completion_webhook_url, completion_webhook_secret_encrypted FROM workflows WHERE id = $1`,
    [workflowId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { completion_webhook_url: string | null; completion_webhook_secret_encrypted: Buffer | null };
  if (!row.completion_webhook_url || !row.completion_webhook_secret_encrypted) return null;
  return { url: row.completion_webhook_url, secretEncrypted: row.completion_webhook_secret_encrypted };
}

/**
 * If the workflow has a completion webhook configured, enqueue one
 * `execution.callback` outbox event. Call this in the same tx that finalizes an
 * execution to a terminal state. Idempotent per execution via the outbox job id.
 */
export async function enqueueCompletionCallback(
  client: pg.PoolClient,
  args: { workflowId: string; executionId: string },
): Promise<boolean> {
  const cb = await getWorkflowCallback(client, args.workflowId);
  if (!cb) return false;
  await insertOutbox(client, { eventType: 'execution.callback', payload: { executionId: args.executionId } });
  return true;
}

export async function getVersion(
  db: Db,
  id: string,
): Promise<{ id: string; workflowId: string; versionNumber: number; definition: unknown } | null> {
  const r = await db.query(`SELECT * FROM workflow_versions WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    id: row['id'] as string,
    workflowId: row['workflow_id'] as string,
    versionNumber: Number(row['version_number']),
    definition: row['definition_json'],
  };
}
