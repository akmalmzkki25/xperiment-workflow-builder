import { type Db } from '../pool.js';

export interface MfaRow {
  userId: string;
  secretEnc: Buffer;
  rootKeyId: string;
  confirmedAt: string | null;
  /** BIGINT: node-postgres hands it back as a string, so it is only ever compared in SQL. */
  lastUsedStep: string | null;
}

interface MfaDbRow {
  user_id: string;
  secret_enc: Buffer;
  root_key_id: string;
  confirmed_at: string | null;
  last_used_step: string | null;
}

/**
 * Stores a fresh unconfirmed secret. Returns false — without writing — when a confirmed
 * factor already exists, so re-running setup cannot swap the secret out from under a
 * factor the user is still relying on.
 */
export async function upsertPendingMfa(
  db: Db,
  args: { userId: string; secretEnc: Buffer; rootKeyId: string },
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO user_mfa (user_id, secret_enc, root_key_id) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_enc = EXCLUDED.secret_enc,
             root_key_id = EXCLUDED.root_key_id,
             last_used_step = NULL,
             created_at = now()
       WHERE user_mfa.confirmed_at IS NULL`,
    [args.userId, args.secretEnc, args.rootKeyId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getMfa(db: Db, userId: string): Promise<MfaRow | null> {
  const r = await db.query(`SELECT * FROM user_mfa WHERE user_id = $1`, [userId]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as MfaDbRow;
  return {
    userId: row.user_id,
    secretEnc: row.secret_enc,
    rootKeyId: row.root_key_id,
    confirmedAt: row.confirmed_at,
    lastUsedStep: row.last_used_step,
  };
}

/** Idempotent: false means it was already confirmed, not that anything failed. */
export async function confirmMfa(db: Db, userId: string): Promise<boolean> {
  const r = await db.query(`UPDATE user_mfa SET confirmed_at = now() WHERE user_id = $1 AND confirmed_at IS NULL`, [
    userId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteMfa(db: Db, userId: string): Promise<void> {
  await db.query(`DELETE FROM user_mfa WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
}

export async function hasConfirmedMfa(db: Db, userId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL`, [userId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Compare-and-set on the replay floor: one statement both checks that the step is newer
 * than anything already spent and records it, so two concurrent logins presenting the same
 * code cannot both win.
 */
export async function claimTotpStep(db: Db, userId: string, step: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE user_mfa SET last_used_step = $2
      WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2)`,
    [userId, step],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Replaces the entire set: any code from the previous batch stops working. */
export async function replaceRecoveryCodes(db: Db, userId: string, hashes: string[]): Promise<void> {
  await db.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
  for (const hash of hashes) {
    await db.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)`, [userId, hash]);
  }
}

/** Compare-and-set, scoped to the owner so one user's code cannot be spent by another. */
export async function consumeRecoveryCode(db: Db, userId: string, hash: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE mfa_recovery_codes SET consumed_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND consumed_at IS NULL`,
    [userId, hash],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Every workspace whose policy requires this user's second factor — that is, where they hold
 * a privileged role and `require_mfa` is on. Disabling MFA while any exist would strand them
 * behind their own workspace's gate.
 */
export async function workspacesRequiringMfa(db: Db, userId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT m.workspace_id FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND w.require_mfa AND m.role IN ('owner','admin')`,
    [userId],
  );
  return (r.rows as { workspace_id: string }[]).map((row) => row.workspace_id);
}

export async function countLiveRecoveryCodes(db: Db, userId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM mfa_recovery_codes WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
  return (r.rows[0] as { c: number }).c;
}
