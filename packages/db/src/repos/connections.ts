import { type Db } from '../pool.js';

export interface ConnectionRow {
  id: string;
  connectorKey: string;
  name: string;
  status: string;
  createdAt: string;
}

function mapConnection(r: Record<string, unknown>): ConnectionRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
  return {
    id: r['id'] as string,
    connectorKey: r['connector_key'] as string,
    name: r['name'] as string,
    status: r['status'] as string,
    createdAt: ts(r['created_at']),
  };
}

export async function createConnection(
  db: Db,
  args: {
    workspaceId: string;
    connectorKey: string;
    name: string;
    encryptedPayload: Buffer;
    /** Omit only for a legacy write; new code passes ENC_VERSION_ENVELOPE. */
    encVersion?: number;
  },
): Promise<ConnectionRow> {
  const r = await db.query(
    `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0)) RETURNING *`,
    [args.workspaceId, args.connectorKey, args.name, args.encryptedPayload, args.encVersion ?? null],
  );
  return mapConnection(r.rows[0] as Record<string, unknown>);
}

export async function listConnections(db: Db, workspaceId: string): Promise<ConnectionRow[]> {
  const r = await db.query(
    `SELECT id, connector_key, name, status, created_at FROM connections WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  return (r.rows as Record<string, unknown>[]).map(mapConnection);
}

export async function getConnectionWithPayload(
  db: Db,
  id: string,
  workspaceId?: string,
): Promise<(ConnectionRow & { workspaceId: string; encryptedPayload: Buffer; encVersion: number }) | null> {
  const r = workspaceId
    ? await db.query(`SELECT * FROM connections WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
    : await db.query(`SELECT * FROM connections WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    ...mapConnection(row),
    workspaceId: row['workspace_id'] as string,
    encryptedPayload: row['encrypted_payload'] as Buffer,
    encVersion: row['enc_version'] as number,
  };
}

export async function deleteConnection(db: Db, id: string, workspaceId: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM connections WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  return (r.rowCount ?? 0) > 0;
}

export async function countPublishedRefs(db: Db, connectionId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM workflow_versions v
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(v.definition_json->'nodes') n
       WHERE n->>'connectionRef' = $1
     )`,
    [connectionId],
  );
  return (r.rows[0] as { c: number }).c;
}
