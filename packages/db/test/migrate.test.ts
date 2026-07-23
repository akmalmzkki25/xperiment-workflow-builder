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
});
