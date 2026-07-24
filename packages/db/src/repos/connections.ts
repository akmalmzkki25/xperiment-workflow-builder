import { DEFAULT_WORKSPACE_ID, type Db } from '../pool.js';

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
  args: { connectorKey: string; name: string; encryptedPayload: Buffer },
): Promise<ConnectionRow> {
  const r = await db.query(
    `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [DEFAULT_WORKSPACE_ID, args.connectorKey, args.name, args.encryptedPayload],
  );
  return mapConnection(r.rows[0] as Record<string, unknown>);
}

export async function listConnections(db: Db): Promise<ConnectionRow[]> {
  const r = await db.query(
    `SELECT id, connector_key, name, status, created_at FROM connections ORDER BY created_at`,
  );
  return (r.rows as Record<string, unknown>[]).map(mapConnection);
}

export async function getConnectionWithPayload(
  db: Db,
  id: string,
): Promise<(ConnectionRow & { encryptedPayload: Buffer }) | null> {
  const r = await db.query(`SELECT * FROM connections WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return { ...mapConnection(row), encryptedPayload: row['encrypted_payload'] as Buffer };
}

export async function deleteConnection(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM connections WHERE id = $1`, [id]);
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
