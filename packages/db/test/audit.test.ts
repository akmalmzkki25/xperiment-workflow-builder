import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, runMigrations, withTx } from '../src/index.js';
import { appendAuditEvent, listAuditEvents } from '../src/repos/audit.js';

let pool: Pool;
let ws: string;
let other: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
  ws = randomUUID();
  other = randomUUID();
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1,'a'), ($2,'b')`, [ws, other]);
});

describe('appendAuditEvent', () => {
  test('stores the actor, target, outcome and metadata', async () => {
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'x')`, [
      userId,
      `u-${userId.slice(0, 8)}@example.com`,
    ]);
    await appendAuditEvent(pool, {
      workspaceId: ws,
      actorKind: 'user',
      actorUserId: userId,
      action: 'credential.create',
      targetType: 'connection',
      targetId: 'conn-1',
      metadata: { connectorKey: 'telegram' },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: ws,
      actorKind: 'user',
      actorUserId: userId,
      action: 'credential.create',
      targetType: 'connection',
      targetId: 'conn-1',
      outcome: 'success',
      metadata: { connectorKey: 'telegram' },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    expect(typeof rows[0]!.id).toBe('string'); // BIGSERIAL arrives as a string
  });

  test('records a failure outcome and an anonymous actor with only a label', async () => {
    await appendAuditEvent(pool, {
      actorKind: 'anonymous',
      actorLabel: 'nobody@example.com',
      action: 'auth.login_failed',
      outcome: 'failure',
    });
    const raw = await pool.query<{ workspace_id: string | null; outcome: string; actor_label: string }>(
      `SELECT workspace_id, outcome, actor_label FROM audit_events`,
    );
    expect(raw.rows[0]).toMatchObject({ workspace_id: null, outcome: 'failure', actor_label: 'nobody@example.com' });
  });

  test('an event emitted inside a rolled-back transaction leaves no row', async () => {
    // The 3M lesson: an audit row must not survive a mutation that was undone.
    await expect(
      withTx(pool, async (client) => {
        await appendAuditEvent(client, { workspaceId: ws, actorKind: 'system', action: 'credential.delete' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(rows).toHaveLength(0);
  });

  test('an event emitted inside a committed transaction leaves exactly one row', async () => {
    await withTx(pool, async (client) => {
      await appendAuditEvent(client, { workspaceId: ws, actorKind: 'system', action: 'credential.delete' });
    });
    expect(await listAuditEvents(pool, { workspaceId: ws, limit: 10 })).toHaveLength(1);
  });

  test('the actor record survives deletion of the user it names', async () => {
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'x')`, [
      userId,
      `gone-${userId.slice(0, 8)}@example.com`,
    ]);
    await appendAuditEvent(pool, {
      workspaceId: ws,
      actorKind: 'user',
      actorUserId: userId,
      actorLabel: 'gone@example.com',
      action: 'credential.delete',
    });
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBeNull();
    expect(rows[0]!.actorLabel).toBe('gone@example.com'); // who it was is still recorded
  });
});

describe('listAuditEvents', () => {
  async function seed(n: number, workspaceId: string, action = 'credential.read_use'): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await appendAuditEvent(pool, {
        workspaceId,
        actorKind: 'system',
        action,
        targetType: 'connection',
        targetId: `c-${i}`,
        metadata: { i },
      });
    }
  }

  test('newest first, and never another workspace’s rows', async () => {
    await seed(3, ws);
    await seed(2, other);
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.targetId)).toEqual(['c-2', 'c-1', 'c-0']);
  });

  test('a global row is never returned to a workspace', async () => {
    await appendAuditEvent(pool, { actorKind: 'anonymous', action: 'auth.login_failed', outcome: 'failure' });
    expect(await listAuditEvents(pool, { workspaceId: ws, limit: 10 })).toHaveLength(0);
  });

  test('keyset pagination returns each row exactly once', async () => {
    await seed(7, ws);
    const first = await listAuditEvents(pool, { workspaceId: ws, limit: 3 });
    const second = await listAuditEvents(pool, { workspaceId: ws, limit: 3, before: first[2]!.id });
    const third = await listAuditEvents(pool, { workspaceId: ws, limit: 3, before: second[2]!.id });
    const seen = [...first, ...second, ...third].map((r) => r.targetId);
    expect(seen).toEqual(['c-6', 'c-5', 'c-4', 'c-3', 'c-2', 'c-1', 'c-0']);
    expect(new Set(seen).size).toBe(7);
  });

  test('filters by action and by target', async () => {
    await seed(2, ws, 'credential.read_use');
    await seed(1, ws, 'credential.create');
    expect(await listAuditEvents(pool, { workspaceId: ws, limit: 10, action: 'credential.create' })).toHaveLength(1);
    const byTarget = await listAuditEvents(pool, {
      workspaceId: ws,
      limit: 10,
      targetType: 'connection',
      targetId: 'c-0',
    });
    expect(byTarget.map((r) => r.action).sort()).toEqual(['credential.create', 'credential.read_use']);
  });

  test('the limit is clamped rather than trusted', async () => {
    await seed(3, ws);
    const rows = await listAuditEvents(pool, { workspaceId: ws, limit: 100000 });
    expect(rows).toHaveLength(3); // clamped to AUDIT_PAGE_MAX, not rejected
  });
});
