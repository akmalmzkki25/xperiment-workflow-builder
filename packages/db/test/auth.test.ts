import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../src/authCrypto.js';
import { createPool, runMigrations } from '../src/index.js';
import {
  acceptInvite,
  addMember,
  createApiKey,
  createInvite,
  createSession,
  createUser,
  createWorkspaceWithOwner,
  getActiveApiKey,
  getActiveSession,
  getMembership,
  getUserByEmail,
  listApiKeys,
  listMembers,
  listMemberships,
  revokeAllSessions,
  revokeApiKey,
  revokeSession,
  updateMemberRole,
} from '../src/repos/auth.js';

let pool: Pool;

/** These tests drive the repo directly, with no request behind them. */
const SYSTEM_ACTOR = { actorKind: 'system' } as const;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  // auth_events is deliberately absent: it is historical data now, no longer written to,
  // and wiping it would destroy records this slice is meant to preserve.
  await pool.query(`TRUNCATE users, sessions, workspace_members, workspace_invites, api_keys CASCADE`);
});

describe('authCrypto', () => {
  test('password hash round-trip; wrong password fails; malformed stored fails', async () => {
    const stored = await hashPassword('rahasia-123');
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(await verifyPassword('rahasia-123', stored)).toBe(true);
    expect(await verifyPassword('salah', stored)).toBe(false);
    expect(await verifyPassword('rahasia-123', 'garbage')).toBe(false);
  });

  test('tokens carry prefixes and hash deterministically', () => {
    const s = generateToken('qs');
    const k = generateToken('qk');
    expect(s.token.startsWith('qs_')).toBe(true);
    expect(k.token.startsWith('qk_')).toBe(true);
    expect(s.hash).toBe(hashToken(s.token));
    expect(s.hash).not.toBe(k.hash);
  });
});

describe('users and sessions', () => {
  test('createUser once; duplicate email returns null; lookup by email', async () => {
    const u = await createUser(pool, { email: 'a@x.test', passwordHash: 'h' });
    expect(u).not.toBeNull();
    expect(await createUser(pool, { email: 'A@X.TEST', passwordHash: 'h' })).toBeNull(); // citext
    expect((await getUserByEmail(pool, 'a@x.test'))?.id).toBe(u!.id);
  });

  test('session lifecycle: active, revoked, expired, revoke-all', async () => {
    const u = (await createUser(pool, { email: 'b@x.test', passwordHash: 'h' }))!;
    const t1 = generateToken('qs');
    const t2 = generateToken('qs');
    await createSession(pool, { userId: u.id, tokenHash: t1.hash, expiresAt: new Date(Date.now() + 60_000) });
    await createSession(pool, { userId: u.id, tokenHash: t2.hash, expiresAt: new Date(Date.now() + 60_000) });
    expect((await getActiveSession(pool, t1.hash))?.userId).toBe(u.id);
    await revokeSession(pool, t1.hash);
    expect(await getActiveSession(pool, t1.hash)).toBeNull();
    expect(await getActiveSession(pool, t2.hash)).not.toBeNull();
    await revokeAllSessions(pool, u.id);
    expect(await getActiveSession(pool, t2.hash)).toBeNull();
    const expired = generateToken('qs');
    await createSession(pool, { userId: u.id, tokenHash: expired.hash, expiresAt: new Date(Date.now() - 1000) });
    expect(await getActiveSession(pool, expired.hash)).toBeNull();
  });
});

describe('workspaces, memberships, invites', () => {
  test('createWorkspaceWithOwner is atomic and listed in memberships', async () => {
    const u = (await createUser(pool, { email: 'c@x.test', passwordHash: 'h' }))!;
    const ws = await createWorkspaceWithOwner(pool, { name: 'Tim C', userId: u.id, actor: SYSTEM_ACTOR });
    const memberships = await listMemberships(pool, u.id);
    // A new workspace does not require MFA until its owner asks for it.
    expect(memberships).toEqual([{ workspaceId: ws.id, name: 'Tim C', role: 'owner', requireMfa: false }]);
    expect((await getMembership(pool, ws.id, u.id))?.role).toBe('owner');
  });

  test('invite accept adds a member once; expired/used invites return null', async () => {
    const owner = (await createUser(pool, { email: 'o@x.test', passwordHash: 'h' }))!;
    const joiner = (await createUser(pool, { email: 'j@x.test', passwordHash: 'h' }))!;
    const ws = await createWorkspaceWithOwner(pool, { name: 'W', userId: owner.id, actor: SYSTEM_ACTOR });
    const inv = generateToken('qs');
    await createInvite(pool, {
      workspaceId: ws.id,
      tokenHash: inv.hash,
      role: 'builder',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await acceptInvite(pool, inv.hash, joiner.id, SYSTEM_ACTOR)).toMatchObject({
      outcome: 'joined',
      workspaceId: ws.id,
      role: 'builder',
      alreadyMember: false,
    });
    expect((await getMembership(pool, ws.id, joiner.id))?.role).toBe('builder');
    expect(await acceptInvite(pool, inv.hash, joiner.id, SYSTEM_ACTOR)).toEqual({ outcome: 'invalid' }); // used
    const stale = generateToken('qs');
    await createInvite(pool, {
      workspaceId: ws.id,
      tokenHash: stale.hash,
      role: 'viewer',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await acceptInvite(pool, stale.hash, joiner.id, SYSTEM_ACTOR)).toEqual({ outcome: 'invalid' }); // expired
    await addMember(pool, { workspaceId: ws.id, userId: joiner.id, role: 'admin' });
    expect((await getMembership(pool, ws.id, joiner.id))?.role).toBe('admin'); // upsert role
  });
});

describe('api keys and auth events', () => {
  test('api key lifecycle with last_used update and revocation', async () => {
    const u = (await createUser(pool, { email: 'k@x.test', passwordHash: 'h' }))!;
    const ws = await createWorkspaceWithOwner(pool, { name: 'W', userId: u.id, actor: SYSTEM_ACTOR });
    const key = generateToken('qk');
    const row = await createApiKey(pool, { workspaceId: ws.id, name: 'ci', keyHash: key.hash });
    expect(row.lastUsedAt).toBeNull();
    expect((await getActiveApiKey(pool, key.hash))?.workspaceId).toBe(ws.id);
    const listed = await listApiKeys(pool, ws.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.lastUsedAt).not.toBeNull();
    expect(await revokeApiKey(pool, row.id, ws.id)).toBe(true);
    expect(await getActiveApiKey(pool, key.hash)).toBeNull();
    expect(await revokeApiKey(pool, row.id, ws.id)).toBe(false);
  });

});

describe('rbac member + api key roles', () => {
  let seq = 0;
  const newUser = async () => (await createUser(pool, { email: `rbac-${(seq += 1)}@x.test`, passwordHash: 'h' }))!;

  test('api keys carry a role, defaulting to builder', async () => {
    const u = await newUser();
    const ws = await createWorkspaceWithOwner(pool, { name: 'K', userId: u.id, actor: SYSTEM_ACTOR });
    const dflt = await createApiKey(pool, { workspaceId: ws.id, name: 'd', keyHash: 'h-default' });
    expect(dflt.role).toBe('builder');
    const scoped = await createApiKey(pool, { workspaceId: ws.id, name: 'v', keyHash: 'h-viewer', role: 'viewer' });
    expect(scoped.role).toBe('viewer');
    expect(await getActiveApiKey(pool, 'h-viewer')).toMatchObject({ workspaceId: ws.id, role: 'viewer' });
    expect((await listApiKeys(pool, ws.id)).find((k) => k.name === 'v')?.role).toBe('viewer');
  });

  test('listMembers returns each member with email and role', async () => {
    const owner = await newUser();
    const other = await newUser();
    const ws = await createWorkspaceWithOwner(pool, { name: 'M', userId: owner.id, actor: SYSTEM_ACTOR });
    await addMember(pool, { workspaceId: ws.id, userId: other.id, role: 'operator' });
    const members = await listMembers(pool, ws.id);
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.userId === other.id)?.role).toBe('operator');
    expect(members.every((m) => m.email.includes('@'))).toBe(true);
  });

  test('updateMemberRole changes a role, refuses the last owner, and reports a non-member', async () => {
    const owner = await newUser();
    const other = await newUser();
    const stranger = await newUser();
    const ws = await createWorkspaceWithOwner(pool, { name: 'R', userId: owner.id, actor: SYSTEM_ACTOR });
    await addMember(pool, { workspaceId: ws.id, userId: other.id, role: 'viewer' });

    expect(
      await updateMemberRole(pool, { workspaceId: ws.id, userId: other.id, role: 'billing', actor: SYSTEM_ACTOR }),
    ).toMatchObject({ outcome: 'ok', previousRole: 'viewer' });
    expect((await listMembers(pool, ws.id)).find((m) => m.userId === other.id)?.role).toBe('billing');

    // the only owner cannot be demoted
    expect(
      await updateMemberRole(pool, { workspaceId: ws.id, userId: owner.id, role: 'viewer', actor: SYSTEM_ACTOR }),
    ).toMatchObject({ outcome: 'last_owner' });
    // once a second owner exists, demotion is allowed
    await updateMemberRole(pool, { workspaceId: ws.id, userId: other.id, role: 'owner', actor: SYSTEM_ACTOR });
    expect(
      await updateMemberRole(pool, { workspaceId: ws.id, userId: owner.id, role: 'viewer', actor: SYSTEM_ACTOR }),
    ).toMatchObject({ outcome: 'ok', previousRole: 'owner' });

    expect(
      await updateMemberRole(pool, { workspaceId: ws.id, userId: stranger.id, role: 'viewer', actor: SYSTEM_ACTOR }),
    ).toMatchObject({ outcome: 'not_member' });
  });

  test('concurrent demotions of different owners cannot empty the owner set', async () => {
    // Warm the pool: on a cold pool the second call spends its head start opening
    // a socket, the transactions never overlap, and the race cannot be observed.
    await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')));

    const pairs: { wsId: string; a: string; b: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await newUser();
      const b = await newUser();
      const ws = await createWorkspaceWithOwner(pool, { name: `Race${i}`, userId: a.id, actor: SYSTEM_ACTOR });
      await addMember(pool, { workspaceId: ws.id, userId: b.id, role: 'owner' });
      pairs.push({ wsId: ws.id, a: a.id, b: b.id });
    }

    // Disjoint target rows: row locks alone would let both guards pass, and both
    // owners would be demoted — a workspace nobody can ever grant `owner` in again.
    const results = await Promise.all(
      pairs.flatMap((p) => [
        updateMemberRole(pool, { workspaceId: p.wsId, userId: p.a, role: 'viewer', actor: SYSTEM_ACTOR }),
        updateMemberRole(pool, { workspaceId: p.wsId, userId: p.b, role: 'viewer', actor: SYSTEM_ACTOR }),
      ]),
    );
    expect(results.filter((r) => r.outcome === 'ok')).toHaveLength(pairs.length);
    expect(results.filter((r) => r.outcome === 'last_owner')).toHaveLength(pairs.length);
    for (const p of pairs) {
      expect((await listMembers(pool, p.wsId)).filter((m) => m.role === 'owner')).toHaveLength(1);
    }
  });

  test('an invalid role is rejected by the CHECK constraint', async () => {
    const owner = await newUser();
    const other = await newUser();
    const ws = await createWorkspaceWithOwner(pool, { name: 'C', userId: owner.id, actor: SYSTEM_ACTOR });
    await expect(
      pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'superuser')`, [
        ws.id,
        other.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
