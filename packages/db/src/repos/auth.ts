import { resolveLimits } from '@xperiment/plans';
import type pg from 'pg';
import { type Db } from '../pool.js';
import { withTx } from '../tx.js';
import { appendAuditEvent, type AuditActor } from './audit.js';
import { getWorkspacePlan } from './entitlements.js';

export type Role = 'viewer' | 'builder' | 'operator' | 'billing' | 'admin' | 'owner';

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  /** Account lifecycle (active/suspended). Distinct from verification — see 0013. */
  status: string;
  emailVerifiedAt: string | null;
}

function mapUser(r: Record<string, unknown>): UserRow {
  const v = r['email_verified_at'];
  return {
    id: r['id'] as string,
    email: r['email'] as string,
    passwordHash: r['password_hash'] as string,
    status: r['status'] as string,
    emailVerifiedAt: v instanceof Date ? v.toISOString() : ((v as string | null) ?? null),
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

export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  const r = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return r.rowCount ? mapUser(r.rows[0] as Record<string, unknown>) : null;
}

/** Idempotent: re-verifying an already-verified address keeps the original timestamp. */
export async function markEmailVerified(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL`, [userId]);
}

export async function updatePassword(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
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
  args: { name: string; userId: string; actor: AuditActor },
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
    // Same transaction as the workspace itself: the audit row's workspace_id foreign key
    // is satisfied because both commit together.
    await appendAuditEvent(client, {
      ...args.actor,
      workspaceId: row.id,
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: row.id,
      metadata: { name: row.name },
    });
    return row;
  });
}

export async function listMemberships(
  db: Db,
  userId: string,
): Promise<{ workspaceId: string; name: string; role: Role; requireMfa: boolean }[]> {
  const r = await db.query(
    `SELECT m.workspace_id, w.name, m.role, w.require_mfa FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY m.created_at`,
    [userId],
  );
  return (r.rows as { workspace_id: string; name: string; role: Role; require_mfa: boolean }[]).map((row) => ({
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
    requireMfa: row.require_mfa,
  }));
}

/**
 * Role plus the workspace's MFA policy in one round trip. The plugin needs both on every
 * authenticated request, and a second query per request to fetch a boolean would be waste.
 */
export async function getMembership(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; role: Role; requireMfa: boolean } | null> {
  const r = await db.query(
    // workspace_id comes back too: the caller supplies this id from a request header, and
    // Postgres matches a uuid parameter regardless of case. Returning the canonical form
    // keeps a non-canonical header out of everything downstream — above all the AES-GCM AAD.
    `SELECT m.workspace_id, m.role, w.require_mfa FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { workspace_id: string; role: Role; require_mfa: boolean };
  return { workspaceId: row.workspace_id, role: row.role, requireMfa: row.require_mfa };
}

export async function setWorkspaceRequireMfa(db: Db, workspaceId: string, enabled: boolean): Promise<void> {
  await db.query(`UPDATE workspaces SET require_mfa = $2 WHERE id = $1`, [workspaceId, enabled]);
}

export async function addMember(db: Db, args: { workspaceId: string; userId: string; role: Role }): Promise<void> {
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [args.workspaceId, args.userId, args.role],
  );
}

/**
 * Returns the invite id so an audit row can target it. The row is otherwise keyed by
 * token_hash, which must never be logged, so without this both invite actions would have a
 * null target and the (workspace_id, target_type, target_id) index could not follow one
 * invite from creation to acceptance.
 */
export async function createInvite(
  db: Db,
  args: { workspaceId: string; tokenHash: string; role: Role; expiresAt: Date },
): Promise<{ id: string }> {
  const r = await db.query(
    `INSERT INTO workspace_invites (workspace_id, token_hash, role, expires_at) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [args.workspaceId, args.tokenHash, args.role, args.expiresAt],
  );
  return { id: (r.rows[0] as { id: string }).id };
}

export type AcceptInviteResult =
  /** `alreadyMember` matters: the membership insert is ON CONFLICT DO NOTHING, so a re-join grants nothing. */
  | { outcome: 'joined'; workspaceId: string; inviteId: string; role: Role; alreadyMember: boolean }
  | { outcome: 'invalid' }
  | { outcome: 'quota_exceeded'; used: number; limit: number };

/**
 * Redeem an invite.
 *
 * The seat limit is enforced here, not at invite time: issuing invites is free and
 * unbounded, so gating only the issue lets N invites be minted under the cap and then
 * all redeemed past it. Joining is the act that consumes a seat, so that is where the
 * check belongs — and it shares `updateMemberRole`'s workspace advisory lock, so
 * concurrent redemptions cannot both read the same pre-join count.
 */
export async function acceptInvite(
  pool: pg.Pool,
  tokenHash: string,
  userId: string,
  actor: AuditActor,
): Promise<AcceptInviteResult> {
  return withTx(pool, async (client) => {
    const invite = await client.query(
      `SELECT id, workspace_id, role FROM workspace_invites
       WHERE token_hash = $1 AND accepted_by IS NULL AND expires_at > now() FOR UPDATE`,
      [tokenHash],
    );
    if (!invite.rowCount) return { outcome: 'invalid' };
    const row = invite.rows[0] as { id: string; workspace_id: string; role: Role };
    const workspaceId = row.workspace_id;

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workspace_role:${workspaceId}`]);

    // Re-joining an existing membership consumes no seat, so only count the new ones.
    const already = await client.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    const alreadyMember = (already.rowCount ?? 0) > 0;
    if (!alreadyMember) {
      const plan = await getWorkspacePlan(client, workspaceId);
      const limit = resolveLimits(plan.planCode, plan.limitOverrides).members;
      if (limit !== null && !plan.allowOverage) {
        const seats = await client.query(`SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1`, [
          workspaceId,
        ]);
        const used = (seats.rows[0] as { c: number }).c;
        if (used >= limit) return { outcome: 'quota_exceeded', used, limit };
      }
    }

    await client.query(`UPDATE workspace_invites SET accepted_by = $1 WHERE token_hash = $2`, [userId, tokenHash]);
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId, row.role],
    );
    // Same transaction as the membership change, and alreadyMember is recorded because the
    // insert above does nothing for an existing member — a row implying a grant would lie.
    await appendAuditEvent(client, {
      ...actor,
      workspaceId,
      action: 'invite.accept',
      targetType: 'invite',
      targetId: row.id,
      metadata: { role: row.role, alreadyMember },
    });
    return { outcome: 'joined', workspaceId, inviteId: row.id, role: row.role, alreadyMember };
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

export async function getActiveApiKey(
  db: Db,
  keyHash: string,
): Promise<{ id: string; workspaceId: string; role: Role } | null> {
  const r = await db.query(
    `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, workspace_id, role`,
    [keyHash],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { id: string; workspace_id: string; role: Role };
  return { id: row.id, workspaceId: row.workspace_id, role: row.role };
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

/** `previousRole` is what the audit row needs: "was viewer, now admin". */
export type UpdateMemberRoleResult =
  | { outcome: 'ok'; previousRole: Role }
  | { outcome: 'not_member' }
  | { outcome: 'last_owner' };

/**
 * Change a member's role. Refuses to demote the last owner.
 *
 * Row locks alone cannot carry this guard: two demotions of *different* owners
 * lock disjoint rows, and under READ COMMITTED each one's owner count reads the
 * other's pre-image, so both pass and the workspace is left with zero owners —
 * an unrecoverable state, since every owner-granting route requires an owner.
 * A workspace-scoped advisory lock serializes all role changes within a
 * workspace instead, and (unlike locking the owner set) cannot deadlock.
 *
 * The actor is passed in rather than the caller supplying a transaction client,
 * because `pg_advisory_xact_lock` only holds until commit: a caller who passed a
 * pool would acquire and instantly release it, and the guard above would
 * silently stop working. Owning the transaction is the point.
 */
export async function updateMemberRole(
  pool: pg.Pool,
  args: { workspaceId: string; userId: string; role: Role; actor: AuditActor },
): Promise<UpdateMemberRoleResult> {
  return withTx(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workspace_role:${args.workspaceId}`]);
    const current = await client.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
      [args.workspaceId, args.userId],
    );
    if (!current.rowCount) return { outcome: 'not_member' };
    const was = (current.rows[0] as { role: Role }).role;
    if (was === 'owner' && args.role !== 'owner') {
      const owners = await client.query(
        `SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
        [args.workspaceId],
      );
      if ((owners.rows[0] as { c: number }).c <= 1) return { outcome: 'last_owner' };
    }
    await client.query(`UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [
      args.workspaceId,
      args.userId,
      args.role,
    ]);
    // Same transaction and the same advisory lock as the change itself, so the record
    // cannot survive a rollback nor be lost when the change commits.
    await appendAuditEvent(client, {
      ...args.actor,
      workspaceId: args.workspaceId,
      action: 'member.role_change',
      targetType: 'user',
      targetId: args.userId,
      metadata: { previousRole: was, newRole: args.role },
    });
    return { outcome: 'ok', previousRole: was };
  });
}

export async function revokeApiKey(db: Db, id: string, workspaceId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [id, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

// appendAuthEvent was here. Authentication events now go to audit_events via
// appendAuditEvent (packages/db/src/repos/audit.ts), which carries the workspace, the
// actor/target split and metadata that auth_events lacks. auth_events is retained as
// historical data and receives no further writes.
