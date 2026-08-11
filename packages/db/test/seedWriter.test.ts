import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createPool, runMigrations, SeedConflictError, seedDemoWorkspace, type SeedSummary } from '../src/index.js';

let pool: Pool;
const seeded: string[] = [];
let n = 0;

const hashDefinition = (d: unknown): string => createHash('sha256').update(JSON.stringify(d)).digest('hex');
const NOW = Date.parse('2026-08-11T09:00:00.000Z');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});

afterEach(async () => {
  // Scoped teardown: these tests share a development database with every other suite,
  // so nothing here may reach beyond the workspaces this file created.
  for (const id of seeded.splice(0)) {
    await pool.query(`DELETE FROM execution_events WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM execution_nodes WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM executions WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM usage_events WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM workflow_versions WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM workflow_drafts WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM workflows WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM connections WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM workspace_plans WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM workspace_keys WHERE workspace_id = $1`, [id]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
  }
});

afterAll(async () => {
  await pool.end();
});

async function seed(runs = 60): Promise<SeedSummary> {
  n += 1;
  const summary = await seedDemoWorkspace(
    { pool, hashDefinition },
    { workspaceName: `Seed Writer Test ${n} (FAKE)`, runs, days: 14, nowMs: NOW, seed: 7 },
  );
  seeded.push(summary.workspaceId);
  return summary;
}

describe('seedDemoWorkspace', () => {
  test('writes a workspace with published, active workflows', async () => {
    const summary = await seed();
    const r = await pool.query<{ status: string; active: boolean; active_version_id: string | null }>(
      `SELECT status, active, active_version_id FROM workflows WHERE workspace_id = $1`,
      [summary.workspaceId],
    );
    expect(r.rowCount).toBe(summary.workflows);
    expect(r.rowCount).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.status).toBe('published');
      expect(row.active).toBe(true);
      expect(row.active_version_id).not.toBeNull();
    }
  });

  test('never inserts an outbox row, so seeding cannot fire real runs', async () => {
    // This is the whole reason the writer avoids createExecutionWithTrigger. If a dev has
    // the stack up, one outbox row per execution means the seeder dispatches real work.
    await pool.query(`DELETE FROM task_outbox`);
    await seed();
    const r = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM task_outbox`);
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  test('does not consume the workspace execution quota', async () => {
    const summary = await seed();
    const r = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM workspace_usage_counters WHERE workspace_id = $1`,
      [summary.workspaceId],
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  test('writes the requested number of executions with a mix of outcomes', async () => {
    const summary = await seed(80);
    expect(summary.executions).toBe(80);
    const r = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*) AS count FROM executions WHERE workspace_id = $1 GROUP BY status`,
      [summary.workspaceId],
    );
    const statuses = new Set(r.rows.map((x) => x.status));
    expect(statuses.has('SUCCEEDED')).toBe(true);
    expect(statuses.has('FAILED')).toBe(true);
  });

  test('a failed run carries an error summary and a failed node; a succeeded run carries neither', async () => {
    const summary = await seed(80);
    const failed = await pool.query<{ error_summary: string | null }>(
      `SELECT error_summary FROM executions WHERE workspace_id = $1 AND status = 'FAILED'`,
      [summary.workspaceId],
    );
    expect(failed.rowCount).toBeGreaterThan(0);
    for (const row of failed.rows) expect(row.error_summary).toBeTruthy();

    const ok = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM executions WHERE workspace_id = $1 AND status = 'SUCCEEDED' AND error_summary IS NOT NULL`,
      [summary.workspaceId],
    );
    expect(Number(ok.rows[0]!.count)).toBe(0);

    const nodes = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM execution_nodes n JOIN executions e ON e.id = n.execution_id
       WHERE n.workspace_id = $1 AND e.status = 'FAILED' AND n.status = 'FAILED' AND n.error_json IS NOT NULL`,
      [summary.workspaceId],
    );
    expect(Number(nodes.rows[0]!.count)).toBeGreaterThan(0);
  });

  test('succeeded nodes carry the payloads the timeline exists to show', async () => {
    const summary = await seed();
    const r = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM execution_nodes
       WHERE workspace_id = $1 AND status = 'SUCCEEDED' AND input_json IS NOT NULL AND output_json IS NOT NULL`,
      [summary.workspaceId],
    );
    expect(Number(r.rows[0]!.count)).toBeGreaterThan(0);
  });

  test('a succeeded trigger emits the body, since that is what downstream expressions read', async () => {
    const summary = await seed();
    const r = await pool.query<{ count: string; missing: string }>(
      `SELECT count(*) AS count,
              count(*) FILTER (WHERE output_json IS NULL) AS missing
       FROM execution_nodes n
       WHERE n.workspace_id = $1 AND n.status = 'SUCCEEDED' AND n.node_id IN ('order_masuk', 'cek_stok', 'tiap_malam')`,
      [summary.workspaceId],
    );
    expect(Number(r.rows[0]!.count)).toBeGreaterThan(0);
    expect(Number(r.rows[0]!.missing)).toBe(0);
  });

  test('usage rows carry the status the dashboard filters on', async () => {
    // repos/usage.ts groups on metadata->>'status'. Without it the succeeded/failed split
    // renders as zero, which reads as a broken chart rather than an empty one.
    const summary = await seed();
    const r = await pool.query<{ status: string | null; count: string }>(
      `SELECT metadata->>'status' AS status, count(*) AS count FROM usage_events
       WHERE workspace_id = $1 AND metric = 'execution' GROUP BY 1`,
      [summary.workspaceId],
    );
    expect(r.rows.every((x) => x.status !== null)).toBe(true);
    expect(r.rows.length).toBeGreaterThan(1);
  });

  test('no run is stored in the future', async () => {
    const summary = await seed();
    const r = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM executions WHERE workspace_id = $1 AND (started_at > $2 OR completed_at > $2)`,
      [summary.workspaceId, new Date(NOW)],
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  test('a RUNNING execution has no completion timestamp', async () => {
    const summary = await seed(120);
    const r = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM executions WHERE workspace_id = $1 AND status = 'RUNNING' AND completed_at IS NOT NULL`,
      [summary.workspaceId],
    );
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  test('skips connections entirely when no vault is supplied', async () => {
    // A plaintext payload would list as healthy and fail GCM auth on the first real run.
    const summary = await seed();
    expect(summary.connections).toBe(0);
    const r = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM connections WHERE workspace_id = $1`, [
      summary.workspaceId,
    ]);
    expect(Number(r.rows[0]!.count)).toBe(0);
  });

  test('seals every connection payload when a vault is supplied', async () => {
    n += 1;
    const encrypt = async (workspaceId: string, plaintext: string) => ({
      blob: Buffer.concat([Buffer.from('sealed:'), Buffer.from(plaintext, 'utf8')]),
      encVersion: 1,
    });
    const summary = await seedDemoWorkspace(
      {
        pool,
        hashDefinition,
        vault: { encrypt, decrypt: async () => '' },
      },
      { workspaceName: `Seed Writer Vault ${n} (FAKE)`, runs: 5, days: 3, nowMs: NOW },
    );
    seeded.push(summary.workspaceId);
    expect(summary.connections).toBeGreaterThan(0);
    const r = await pool.query<{ enc_version: number; encrypted_payload: Buffer }>(
      `SELECT enc_version, encrypted_payload FROM connections WHERE workspace_id = $1`,
      [summary.workspaceId],
    );
    expect(r.rowCount).toBe(summary.connections);
    for (const row of r.rows) {
      expect(row.enc_version).toBe(1);
      expect(row.encrypted_payload.subarray(0, 7).toString()).toBe('sealed:');
    }
  });

  test('refuses to seed a second demo over an existing one', async () => {
    const summary = await seed(5);
    await expect(
      seedDemoWorkspace({ pool, hashDefinition }, { workspaceName: summary.workspaceName, runs: 5 }),
    ).rejects.toBeInstanceOf(SeedConflictError);
  });
});
