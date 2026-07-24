import type pg from 'pg';
import { type Db } from '../pool.js';
import { withTx } from '../tx.js';

export type Role = 'viewer' | 'builder' | 'admin' | 'owner';

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  status: string;
}

function mapUser(r: Record<string, unknown>): UserRow {
  return {
    id: r['id'] as string,
    email: r['email'] as string,
    passwordHash: r['password_hash'] as string,
    status: r['status'] as string,
  };
}

export async function createUser(db: Db, args: { email: string; passwordHash: string }): Promise<UserRow | null> {
  try {
    const r = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *`, [
      args.email,
      args.passwordHash,
    ]);
    return mapUser(r.rows[0] as Record<string, unknown>);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return null;
    throw e;
  }
}

export async function getUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const r = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return r.rowCount ? mapUser(r.rows[0] as Record<string, unknown>) : null;
}

export async function createSession(
  db: Db,
  args: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    args.userId,
    args.tokenHash,
    args.expiresAt,
  ]);
}

export async function getActiveSession(db: Db, tokenHash: string): Promise<{ userId: string; email: string } | null> {
  const r = await db.query(
    `SELECT s.user_id, u.email FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [tokenHash],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { user_id: string; email: string };
  return { userId: row.user_id, email: row.email };
}

export async function revokeSession(db: Db, tokenHash: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

export async function createWorkspaceWithOwner(
  pool: pg.Pool,
  args: { name: string; userId: string },
): Promise<{ id: string; name: string }> {
  return withTx(pool, async (client) => {
    const ws = await client.query(`INSERT INTO workspaces (id, name) VALUES (gen_random_uuid(), $1) RETURNING id, name`, [
      args.name,
    ]);
    const row = ws.rows[0] as { id: string; name: string };
    await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      row.id,
      args.userId,
    ]);
    return row;
  });
}

export async function listMemberships(
  db: Db,
  userId: string,
): Promise<{ workspaceId: string; name: string; role: Role }[]> {
  const r = await db.query(
    `SELECT m.workspace_id, w.name, m.role FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY m.created_at`,
    [userId],
  );
  return (r.rows as { workspace_id: string; name: string; role: Role }[]).map((row) => ({
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
  }));
}

export async function getMembership(db: Db, workspaceId: string, userId: string): Promise<Role | null> {
  const r = await db.query(`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [
    workspaceId,
    userId,
  ]);
  return r.rowCount ? ((r.rows[0] as { role: Role }).role) : null;
}

export async function addMember(db: Db, args: { workspaceId: string; userId: string; role: Role }): Promise<void> {
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [args.workspaceId, args.userId, args.role],
  );
}

export async function createInvite(
  db: Db,
  args: { workspaceId: string; tokenHash: string; role: Role; expiresAt: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO workspace_invites (workspace_id, token_hash, role, expires_at) VALUES ($1, $2, $3, $4)`,
    [args.workspaceId, args.tokenHash, args.role, args.expiresAt],
  );
}

export async function acceptInvite(pool: pg.Pool, tokenHash: string, userId: string): Promise<string | null> {
  return withTx(pool, async (client) => {
    const r = await client.query(
      `UPDATE workspace_invites SET accepted_by = $1
       WHERE token_hash = $2 AND accepted_by IS NULL AND expires_at > now()
       RETURNING workspace_id, role`,
      [userId, tokenHash],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0] as { workspace_id: string; role: Role };
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [row.workspace_id, userId, row.role],
    );
    return row.workspace_id;
  });
}

export interface ApiKeyRow {
  id: string;
  workspaceId: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function createApiKey(
  db: Db,
  args: { workspaceId: string; name: string; keyHash: string },
): Promise<ApiKeyRow> {
  const r = await db.query(
    `INSERT INTO api_keys (workspace_id, name, key_hash) VALUES ($1, $2, $3) RETURNING *`,
    [args.workspaceId, args.name, args.keyHash],
  );
  const row = r.rows[0] as Record<string, unknown>;
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    id: row['id'] as string,
    workspaceId: row['workspace_id'] as string,
    name: row['name'] as string,
    lastUsedAt: ts(row['last_used_at']),
    createdAt: ts(row['created_at'])!,
  };
}

export async function getActiveApiKey(db: Db, keyHash: string): Promise<{ workspaceId: string } | null> {
  const r = await db.query(
    `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING workspace_id`,
    [keyHash],
  );
  return r.rowCount ? { workspaceId: (r.rows[0] as { workspace_id: string }).workspace_id } : null;
}

export async function listApiKeys(db: Db, workspaceId: string): Promise<ApiKeyRow[]> {
  const r = await db.query(
    `SELECT id, workspace_id, name, last_used_at, created_at FROM api_keys
     WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [workspaceId],
  );
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    id: row['id'] as string,
    workspaceId: row['workspace_id'] as string,
    name: row['name'] as string,
    lastUsedAt: ts(row['last_used_at']),
    createdAt: ts(row['created_at'])!,
  }));
}

export async function revokeApiKey(db: Db, id: string, workspaceId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [id, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function appendAuthEvent(
  db: Db,
  args: { userId?: string; email?: string; eventType: string; ip?: string },
): Promise<void> {
  await db.query(`INSERT INTO auth_events (user_id, email, event_type, ip) VALUES ($1, $2, $3, $4)`, [
    args.userId ?? null,
    args.email ?? null,
    args.eventType,
    args.ip ?? null,
  ]);
}
