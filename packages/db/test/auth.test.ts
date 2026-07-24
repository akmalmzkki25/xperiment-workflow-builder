import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../src/authCrypto.js';
import { createPool, runMigrations } from '../src/index.js';
import {
  acceptInvite,
  addMember,
  appendAuthEvent,
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
  listMemberships,
  revokeAllSessions,
  revokeApiKey,
  revokeSession,
} from '../src/repos/auth.js';

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE users, sessions, workspace_members, workspace_invites, api_keys, auth_events CASCADE`);
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
    const ws = await createWorkspaceWithOwner(pool, { name: 'Tim C', userId: u.id });
    const memberships = await listMemberships(pool, u.id);
    expect(memberships).toEqual([{ workspaceId: ws.id, name: 'Tim C', role: 'owner' }]);
    expect(await getMembership(pool, ws.id, u.id)).toBe('owner');
  });

  test('invite accept adds a member once; expired/used invites return null', async () => {
    const owner = (await createUser(pool, { email: 'o@x.test', passwordHash: 'h' }))!;
    const joiner = (await createUser(pool, { email: 'j@x.test', passwordHash: 'h' }))!;
    const ws = await createWorkspaceWithOwner(pool, { name: 'W', userId: owner.id });
    const inv = generateToken('qs');
    await createInvite(pool, {
      workspaceId: ws.id,
      tokenHash: inv.hash,
      role: 'builder',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await acceptInvite(pool, inv.hash, joiner.id)).toBe(ws.id);
    expect(await getMembership(pool, ws.id, joiner.id)).toBe('builder');
    expect(await acceptInvite(pool, inv.hash, joiner.id)).toBeNull(); // used
    const stale = generateToken('qs');
    await createInvite(pool, {
      workspaceId: ws.id,
      tokenHash: stale.hash,
      role: 'viewer',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await acceptInvite(pool, stale.hash, joiner.id)).toBeNull(); // expired
    await addMember(pool, { workspaceId: ws.id, userId: joiner.id, role: 'admin' });
    expect(await getMembership(pool, ws.id, joiner.id)).toBe('admin'); // upsert role
  });
});

describe('api keys and auth events', () => {
  test('api key lifecycle with last_used update and revocation', async () => {
    const u = (await createUser(pool, { email: 'k@x.test', passwordHash: 'h' }))!;
    const ws = await createWorkspaceWithOwner(pool, { name: 'W', userId: u.id });
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

  test('auth events append', async () => {
    await appendAuthEvent(pool, { email: 'x@y.test', eventType: 'login_failed', ip: '127.0.0.1' });
    const r = await pool.query(`SELECT event_type FROM auth_events`);
    expect((r.rows[0] as { event_type: string }).event_type).toBe('login_failed');
  });
});
