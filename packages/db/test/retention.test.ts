import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  clampPolicy,
  createPool,
  createVersion,
  createWorkflow,
  DEFAULT_WORKSPACE_ID,
  pruneExpired,
  runMigrations,
} from '../src/index.js';

let pool: Pool;
let workflowId: string;
let versionId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Retention' });
  workflowId = wf.id;
  const v = await createVersion(pool, { workflowId, definition: { schemaVersion: '0.1' }, hash: 'r' });
  versionId = v.id;
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`DELETE FROM execution_waits WHERE workspace_id = $1`, [DEFAULT_WORKSPACE_ID]);
  await pool.query(`DELETE FROM executions WHERE workflow_id = $1`, [workflowId]);
  await pool.query(`DELETE FROM trigger_events WHERE workflow_id = $1`, [workflowId]);
  await pool.query(`DELETE FROM task_outbox`);
});

/** An execution dated `ageDays` in the past, optionally with an open wait. */
async function agedExecution(ageDays: number, withWait: boolean): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, created_at)
     VALUES ($1, $2, $3, 'SUCCEEDED', now() - make_interval(days => $4)) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, workflowId, versionId, ageDays],
  );
  const id = r.rows[0]!.id;
  await pool.query(
    `INSERT INTO execution_events (workspace_id, execution_id, event_type) VALUES ($1, $2, 'created')`,
    [DEFAULT_WORKSPACE_ID, id],
  );
  if (withWait) {
    await pool.query(
      `INSERT INTO execution_waits (workspace_id, execution_id, node_id, attempt, kind, status, resume_token)
       VALUES ($1, $2, 'n', 1, 'timer', 'open', $3)`,
      [DEFAULT_WORKSPACE_ID, id, `tok-${id}`],
    );
  }
  return id;
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await pool.query<{ c: string }>(sql, params)).rows[0]!.c);

describe('clampPolicy', () => {
  test('audit and usage have floors an operator cannot go under', async () => {
    // Deleting usage early rewrites invoices already sent; deleting audit early
    // destroys the record of who did what, which is the whole point of the log.
    const p = clampPolicy({ auditDays: 1, usageDays: 1 });
    expect(p.auditDays).toBe(90);
    expect(p.usageDays).toBe(365);
  });

  test('trigger events are never kept for less time than executions', async () => {
    // Otherwise every sweep would have to unhook the same executions again.
    expect(clampPolicy({ executionDays: 90, triggerEventDays: 7 }).triggerEventDays).toBe(90);
  });

  test('an empty request produces sane defaults', () => {
    const p = clampPolicy({});
    expect(p.executionDays).toBe(30);
    expect(p.outboxDays).toBe(7);
  });
});

describe('pruneExpired', () => {
  test('an execution with an open wait is deleted, not a 23503', async () => {
    // execution_waits.execution_id has NO ON DELETE CASCADE and the column is NOT
    // NULL, so deleting the parent first fails outright. The order is the fix.
    const id = await agedExecution(60, true);
    const result = await pruneExpired(pool, { executionDays: 30 });
    expect(result.executionWaits).toBeGreaterThanOrEqual(1);
    expect(result.executions).toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT count(*) AS c FROM executions WHERE id = $1`, [id])).toBe(0);
  });

  test('events cascade with their execution', async () => {
    const id = await agedExecution(60, false);
    await pruneExpired(pool, { executionDays: 30 });
    expect(await count(`SELECT count(*) AS c FROM execution_events WHERE execution_id = $1`, [id])).toBe(0);
  });

  test('a young execution is left alone', async () => {
    const id = await agedExecution(1, true);
    await pruneExpired(pool, { executionDays: 30 });
    expect(await count(`SELECT count(*) AS c FROM executions WHERE id = $1`, [id])).toBe(1);
  });

  test('an old trigger event is unhooked, and its execution survives', async () => {
    // The run outlives the webhook body that started it; losing the run because the
    // payload aged out would be the wrong trade.
    const te = await pool.query<{ id: string }>(
      `INSERT INTO trigger_events (workspace_id, workflow_id, idempotency_key, payload_json, received_at)
       VALUES ($1, $2, 'k1', '{}'::jsonb, now() - make_interval(days => 400)) RETURNING id`,
      [DEFAULT_WORKSPACE_ID, workflowId],
    );
    const ex = await pool.query<{ id: string }>(
      `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, trigger_event_id)
       VALUES ($1, $2, $3, 'SUCCEEDED', $4) RETURNING id`,
      [DEFAULT_WORKSPACE_ID, workflowId, versionId, te.rows[0]!.id],
    );

    const result = await pruneExpired(pool, { executionDays: 30, triggerEventDays: 30 });
    expect(result.triggerEvents).toBeGreaterThanOrEqual(1);
    const row = await pool.query<{ trigger_event_id: string | null }>(
      `SELECT trigger_event_id FROM executions WHERE id = $1`,
      [ex.rows[0]!.id],
    );
    expect(row.rows[0]!.trigger_event_id).toBeNull();
  });

  test('only PUBLISHED outbox rows are pruned', async () => {
    await pool.query(
      `INSERT INTO task_outbox (event_type, payload_json, published_at)
       VALUES ('node.task', '{}'::jsonb, now() - make_interval(days => 30))`,
    );
    await pool.query(
      `INSERT INTO task_outbox (event_type, payload_json, created_at)
       VALUES ('node.task', '{}'::jsonb, now() - make_interval(days => 30))`,
    );
    const result = await pruneExpired(pool, {});
    expect(result.outbox).toBe(1);
    // An unpublished row is work that has not happened yet, however old it looks.
    expect(await count(`SELECT count(*) AS c FROM task_outbox WHERE published_at IS NULL`)).toBe(1);
  });

  test('a sweep with nothing to do reports zeroes rather than failing', async () => {
    const result = await pruneExpired(pool, {});
    expect(result.executions).toBe(0);
    expect(result.outbox).toBe(0);
  });

  test('the batch bound caps one sweep', async () => {
    for (let i = 0; i < 5; i += 1) await agedExecution(60, false);
    const first = await pruneExpired(pool, { executionDays: 30 }, 2);
    expect(first.executions).toBe(2);
    const second = await pruneExpired(pool, { executionDays: 30 }, 2);
    expect(second.executions).toBe(2);
  });

  test('usage is dated by occurred_at, not by insert time', async () => {
    // A backfilled event carries an old occurred_at and a fresh created_at. Invoicing
    // reads occurred_at, so retention has to as well or the two disagree.
    await pool.query(
      `INSERT INTO usage_events (workspace_id, metric, quantity, occurred_at, created_at)
       VALUES ($1, 'execution', 1, now() - make_interval(days => 400), now())`,
      [DEFAULT_WORKSPACE_ID],
    );
    const before = await count(`SELECT count(*) AS c FROM usage_events WHERE workspace_id = $1`, [
      DEFAULT_WORKSPACE_ID,
    ]);
    const result = await pruneExpired(pool, {});
    expect(result.usageEvents).toBeGreaterThanOrEqual(1);
    expect(
      await count(`SELECT count(*) AS c FROM usage_events WHERE workspace_id = $1`, [DEFAULT_WORKSPACE_ID]),
    ).toBeLessThan(before);
  });
});
