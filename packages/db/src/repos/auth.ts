import type pg from 'pg';
import { type Db } from '../pool.js';
import { withTx } from '../tx.js';

export type Role = 'viewer' | 'builder' | 'operator' | 'billing' | 'admin' | 'owner';

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
    // A workspace is born with a plan and a managed quota alert rule, so enforcement
    // and warning are never retro-fitted onto a workspace that predates them.
    await client.query(`INSERT INTO workspace_plans (workspace_id) VALUES ($1)`, [row.id]);
    await client.query(
      `INSERT INTO alert_rules (workspace_id, name, type, params, managed, cooldown_minutes)
       VALUES ($1, 'Plan quota', 'quota', '{}'::jsonb, true, 720)`,
      [row.id],
    );
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
  role: Role;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function createApiKey(
  db: Db,
  args: { workspaceId: string; name: string; keyHash: string; role?: Role },
): Promise<ApiKeyRow> {
  const r = await db.query(
    `INSERT INTO api_keys (workspace_id, name, key_hash, role) VALUES ($1, $2, $3, COALESCE($4,'builder')) RETURNING *`,
    [args.workspaceId, args.name, args.keyHash, args.role ?? null],
  );
  const row = r.rows[0] as Record<string, unknown>;
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    id: row['id'] as string,
    workspaceId: row['workspace_id'] as string,
    name: row['name'] as string,
    role: row['role'] as Role,
    lastUsedAt: ts(row['last_used_at']),
    createdAt: ts(row['created_at'])!,
  };
}

export async function getActiveApiKey(db: Db, keyHash: string): Promise<{ workspaceId: string; role: Role } | null> {
  const r = await db.query(
    `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING workspace_id, role`,
    [keyHash],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { workspace_id: string; role: Role };
  return { workspaceId: row.workspace_id, role: row.role };
}

export async function listApiKeys(db: Db, workspaceId: string): Promise<ApiKeyRow[]> {
  const r = await db.query(
    `SELECT id, workspace_id, name, role, last_used_at, created_at FROM api_keys
     WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [workspaceId],
  );
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    id: row['id'] as string,
    workspaceId: row['workspace_id'] as string,
    name: row['name'] as string,
    role: row['role'] as Role,
    lastUsedAt: ts(row['last_used_at']),
    createdAt: ts(row['created_at'])!,
  }));
}

export async function listMembers(
  db: Db,
  workspaceId: string,
): Promise<{ userId: string; email: string; role: Role; createdAt: string }[]> {
  const r = await db.query(
    `SELECT m.user_id, u.email, m.role, m.created_at
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 ORDER BY m.created_at`,
    [workspaceId],
  );
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    userId: row['user_id'] as string,
    email: row['email'] as string,
    role: row['role'] as Role,
    createdAt: ts(row['created_at']),
  }));
}

/**
 * Change a member's role. Refuses to demote the last owner.
 *
 * Row locks alone cannot carry this guard: two demotions of *different* owners
 * lock disjoint rows, and under READ COMMITTED each one's owner count reads the
 * other's pre-image, so both pass and the workspace is left with zero owners —
 * an unrecoverable state, since every owner-granting route requires an owner.
 * A workspace-scoped advisory lock serializes all role changes within a
 * workspace instead, and (unlike locking the owner set) cannot deadlock.
 */
export async function updateMemberRole(
  pool: pg.Pool,
  args: { workspaceId: string; userId: string; role: Role },
): Promise<'ok' | 'not_member' | 'last_owner'> {
  return withTx(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workspace_role:${args.workspaceId}`]);
    const current = await client.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
      [args.workspaceId, args.userId],
    );
    if (!current.rowCount) return 'not_member';
    const was = (current.rows[0] as { role: Role }).role;
    if (was === 'owner' && args.role !== 'owner') {
      const owners = await client.query(
        `SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
        [args.workspaceId],
      );
      if ((owners.rows[0] as { c: number }).c <= 1) return 'last_owner';
    }
    await client.query(`UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [
      args.workspaceId,
      args.userId,
      args.role,
    ]);
    return 'ok';
  });
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
