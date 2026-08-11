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

/**
 * `workspaceId` is required. It used to be optional and the worker omitted it
 * (runTask.ts:56), so a published IR naming any connection UUID resolved it — and for a
 * pre-envelope row, which carries no workspace binding, the node would then succeed on
 * another tenant's credential. Requiring the argument turns that class of omission into
 * a compile error rather than something to remember.
 */
export async function getConnectionWithPayload(
  db: Db,
  id: string,
  workspaceId: string,
): Promise<(ConnectionRow & { workspaceId: string; encryptedPayload: Buffer; encVersion: number }) | null> {
  const r = await db.query(`SELECT * FROM connections WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    ...mapConnection(row),
    workspaceId: row['workspace_id'] as string,
    encryptedPayload: row['encrypted_payload'] as Buffer,
    encVersion: row['enc_version'] as number,
  };
}

/**
 * Replace a connection's sealed payload in place.
 *
 * Rotation, not editing. The row keeps its id, so every published version that names it
 * keeps working — which is the entire point: without this, an expired provider token
 * meant creating a second connection, hand-editing `connectionRef` on every node,
 * republishing each workflow, and only then deleting the old one.
 *
 * `connector_key` is deliberately not a parameter. Changing it would leave published
 * nodes pointing at a connection whose payload no longer matches the connector they call,
 * and the failure would surface as a runtime validation error nobody could trace back.
 */
export async function replaceConnectionPayload(
  db: Db,
  args: { id: string; workspaceId: string; encryptedPayload: Buffer; encVersion: number; name?: string | undefined },
): Promise<ConnectionRow | null> {
  const r = await db.query(
    `UPDATE connections
        SET encrypted_payload = $3, enc_version = $4, name = COALESCE($5, name), updated_at = now()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *`,
    [args.id, args.workspaceId, args.encryptedPayload, args.encVersion, args.name ?? null],
  );
  return r.rowCount ? mapConnection(r.rows[0] as Record<string, unknown>) : null;
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
