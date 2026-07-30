import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, DEFAULT_WORKSPACE_ID, runMigrations } from '../src/index.js';

let pool: Pool;

beforeAll(() => {
  pool = createPool();
});
afterAll(async () => {
  await pool.end();
});

describe('runMigrations', () => {
  test('applies then is idempotent', async () => {
    await runMigrations(pool); // first run may or may not apply depending on db state
    const second = await runMigrations(pool);
    expect(second).toEqual([]); // nothing new on re-run
  });

  test('creates all phase-0 tables', async () => {
    const r = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = r.rows.map((x) => x.table_name);
    for (const t of [
      'schema_migrations',
      'workspaces',
      'workflows',
      'workflow_drafts',
      'workflow_versions',
      'trigger_events',
      'executions',
      'execution_nodes',
      'execution_events',
      'task_outbox',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  test('seeds the default workspace', async () => {
    const r = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM workspaces WHERE id = $1`, [
      DEFAULT_WORKSPACE_ID,
    ]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.name).toBe('default');
  });

  test('0012 adds a version column to every encrypted column, defaulting existing rows to 0', async () => {
    const r = await pool.query<{
      table_name: string;
      column_name: string;
      column_default: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE (table_name, column_name) IN (
         ('connections','enc_version'),
         ('workflow_triggers','secret_enc_version'),
         ('workflows','completion_webhook_enc_version'),
         ('alert_rules','webhook_secret_enc_version'))
       ORDER BY table_name`,
    );
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) {
      expect(row.column_default, row.table_name).toContain('0');
      expect(row.is_nullable, row.table_name).toBe('NO');
    }
  });

  test('workspace_keys is keyed one-per-workspace and cascades on workspace delete', async () => {
    const pk = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'workspace_keys'::regclass AND i.indisprimary`,
    );
    expect(pk.rows.map((r) => r.column_name)).toEqual(['workspace_id']);
    const fk = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'workspace_keys'::regclass AND contype = 'f'`,
    );
    expect(fk.rows.map((r) => r.confdeltype)).toEqual(['c']); // 'c' = ON DELETE CASCADE
  });

  test('audit_events keeps the actor record when the user row is deleted', async () => {
    const fk = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'audit_events'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    const types = fk.rows.map((r) => r.confdeltype);
    // The user and api-key references null out ('n'); the workspace reference cascades ('c').
    expect(types.filter((t) => t === 'n')).toHaveLength(2);
    expect(types.filter((t) => t === 'c')).toHaveLength(1);
  });

  test('audit_events rejects an unknown actor_kind and an unknown outcome', async () => {
    // Asserted on the SQLSTATE, not merely that it threw: 23514 is check_violation,
    // whereas a missing table raises 42P01. A bare rejects.toThrow() passes before the
    // migration exists at all, which would make this test worthless.
    const sqlstateOf = async (sql: string): Promise<string | undefined> => {
      try {
        await pool.query(sql);
        return undefined;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(await sqlstateOf(`INSERT INTO audit_events (actor_kind, action) VALUES ('robot', 'x')`)).toBe('23514');
    expect(
      await sqlstateOf(`INSERT INTO audit_events (actor_kind, action, outcome) VALUES ('system', 'x', 'maybe')`),
    ).toBe('23514');
  });
});
