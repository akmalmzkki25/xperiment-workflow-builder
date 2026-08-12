import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createPool,
  createVersion,
  createWorkflow,
  CursorError,
  DEFAULT_WORKSPACE_ID,
  listExecutions,
  runMigrations,
} from '../src/index.js';

let pool: Pool;
let workflowId: string;
let otherWorkflowId: string;
let versionId: string;
let otherVersionId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Filter A' });
  workflowId = wf.id;
  versionId = (await createVersion(pool, { workflowId, definition: { schemaVersion: '0.1' }, hash: 'f1' })).id;
  const other = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Filter B' });
  otherWorkflowId = other.id;
  otherVersionId = (
    await createVersion(pool, { workflowId: otherWorkflowId, definition: { schemaVersion: '0.1' }, hash: 'f2' })
  ).id;
});
afterAll(async () => {
  await pool.query(`DELETE FROM executions WHERE workflow_id = ANY($1)`, [[workflowId, otherWorkflowId]]);
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`DELETE FROM executions WHERE workflow_id = ANY($1)`, [[workflowId, otherWorkflowId]]);
});

/** `minutesAgo` keeps the ordering explicit rather than depending on insert speed. */
async function execution(status: string, minutesAgo: number, wf = workflowId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, created_at)
     VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5)) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, wf, wf === workflowId ? versionId : otherVersionId, status, minutesAgo],
  );
  return r.rows[0]!.id;
}

describe('server-side status filtering', () => {
  test('finds a failure buried past the first page', async () => {
    // The bug this exists for: the page fetched twenty rows and filtered them in the
    // browser, so a failure sitting at position 21 was simply unreachable.
    const failed = await execution('FAILED', 500);
    for (let i = 0; i < 25; i += 1) await execution('SUCCEEDED', i);
    const page = await listExecutions(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      status: ['FAILED'],
      limit: 20,
    });
    expect(page.items.map((e) => e.id)).toEqual([failed]);
  });

  test('several statuses in one look', async () => {
    await execution('FAILED', 3);
    await execution('TIMED_OUT', 2);
    await execution('SUCCEEDED', 1);
    const page = await listExecutions(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      status: ['FAILED', 'TIMED_OUT'],
      limit: 20,
    });
    expect(page.items.map((e) => e.status).sort()).toEqual(['FAILED', 'TIMED_OUT']);
  });

  test('an empty status list means no predicate, not no rows', async () => {
    await execution('SUCCEEDED', 1);
    const page = await listExecutions(pool, { workspaceId: DEFAULT_WORKSPACE_ID, status: [], limit: 20 });
    expect(page.items.length).toBeGreaterThan(0);
  });

  test('status and workflow compose', async () => {
    await execution('FAILED', 2);
    const otherFailed = await execution('FAILED', 1, otherWorkflowId);
    const page = await listExecutions(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      workflowId: otherWorkflowId,
      status: ['FAILED'],
      limit: 20,
    });
    expect(page.items.map((e) => e.id)).toEqual([otherFailed]);
  });
});

describe('pagination under a filter', () => {
  test('walks the whole filtered set without repeating or skipping', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) ids.push(await execution('FAILED', i));
    await execution('SUCCEEDED', 99);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await listExecutions(pool, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        status: ['FAILED'],
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((e) => e.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('a cursor minted under a different filter is refused, not followed', async () => {
    for (let i = 0; i < 5; i += 1) await execution('FAILED', i);
    for (let i = 0; i < 5; i += 1) await execution('SUCCEEDED', i + 10);
    const page = await listExecutions(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      status: ['FAILED'],
      limit: 2,
    });
    expect(page.nextCursor).not.toBeNull();
    // Without the fingerprint this call returns the unfiltered rows after that position:
    // a real result set, silently the wrong one.
    await expect(
      listExecutions(pool, { workspaceId: DEFAULT_WORKSPACE_ID, limit: 2, cursor: page.nextCursor! }),
    ).rejects.toBeInstanceOf(CursorError);
  });

  test('the last page reports no next cursor', async () => {
    await execution('FAILED', 1);
    const page = await listExecutions(pool, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      status: ['FAILED'],
      limit: 20,
    });
    expect(page.nextCursor).toBeNull();
  });
});

describe('an index can serve the filtered list', () => {
  /**
   * Seeded with volume, then ANALYZEd, because a query plan is a function of statistics.
   *
   * The first version of these tests asserted plans against whatever rows the other tests
   * in this file happened to leave behind. They passed, then failed the moment a change
   * elsewhere emptied the table — the planner reads an empty table with `enable_seqscan
   * = off` and picks `idx_executions_created_at` with an Incremental Sort for *every*
   * shape, so the assertions were measuring test-order luck rather than the schema.
   *
   * Two thousand rows at a realistic skew — failures are rare, which is exactly why the
   * status index matters — make the answer the one a production table would give.
   */
  let volumeWorkflowId: string;

  beforeAll(async () => {
    const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Filter volume' });
    volumeWorkflowId = wf.id;
    const version = await createVersion(pool, {
      workflowId: volumeWorkflowId,
      definition: { schemaVersion: '0.1' },
      hash: 'fv',
    });
    await pool.query(
      `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, created_at)
       SELECT $1, $2, $3,
              CASE WHEN i % 40 = 0 THEN 'FAILED' WHEN i % 97 = 0 THEN 'TIMED_OUT' ELSE 'SUCCEEDED' END,
              now() - make_interval(mins => i)
         FROM generate_series(1, 2000) AS i`,
      [DEFAULT_WORKSPACE_ID, volumeWorkflowId, version.id],
    );
    await pool.query('ANALYZE executions');
  }, 60000);

  afterAll(async () => {
    await pool.query(`DELETE FROM executions WHERE workflow_id = $1`, [volumeWorkflowId]);
    await pool.query('ANALYZE executions');
  });

  async function plan(sql: string, params: unknown[]): Promise<string> {
    const explained = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
    return explained.rows.map((r) => r['QUERY PLAN']).join('\n');
  }

  test('one status reads straight off the index, in order, with no Sort', async () => {
    // This is what drove the query builder, and the ordering is the point rather than the
    // index: a scalar predicate gives an Index Scan whose output is ALREADY in
    // (created_at DESC, id DESC), so LIMIT 21 reads twenty-one index entries and stops.
    const text = await plan(
      `SELECT * FROM executions WHERE workspace_id = $1 AND status = $2
        ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID, 'FAILED'],
    );
    expect(text, text).toContain('idx_executions_ws_status_created');
    expect(text, text).toMatch(/Index Cond:[\s\S]*status/);
    expect(text, text).not.toContain('Sort');
  });

  test('an array predicate keeps the index but LOSES the ordering, which is why it is avoided', async () => {
    // Measured under volume, and it corrects the reason: `= ANY('{FAILED}')` does use
    // idx_executions_ws_status_created — as a Bitmap Index Scan, which cannot emit rows in
    // index order. Postgres therefore sorts the WHOLE matching set before taking twenty-one
    // rows. On a workspace with a year of failures that is the difference between reading
    // twenty-one index entries and sorting thousands.
    const text = await plan(
      `SELECT * FROM executions WHERE workspace_id = $1 AND status = ANY($2::text[])
        ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID, ['FAILED']],
    );
    expect(text, text).toContain('Sort');
  });

  test('the unfiltered list reads in index order rather than sorting', async () => {
    // No Sort node: the index already carries the ordering the page asks for. Without it
    // every page would order the workspace's whole history before taking twenty rows.
    const text = await plan(
      `SELECT * FROM executions WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID],
    );
    expect(text, text).toContain('idx_executions_ws_created');
    expect(text, text).not.toContain('Sort');
  });

  test('the index still serves a page deep into the history', async () => {
    // A keyset page four hundred rows in must not degrade into a scan; that is the whole
    // reason the index ends in (created_at DESC, id DESC).
    const anchor = await pool.query<{ created_at: Date; id: string }>(
      `SELECT created_at, id FROM executions WHERE workspace_id = $1
        ORDER BY created_at DESC, id DESC OFFSET 400 LIMIT 1`,
      [DEFAULT_WORKSPACE_ID],
    );
    const row = anchor.rows[0]!;
    const text = await plan(
      `SELECT * FROM executions WHERE workspace_id = $1
         AND (created_at, id) < ($2::timestamptz, $3::uuid)
        ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID, row.created_at.toISOString(), row.id],
    );
    expect(text, text).toContain('idx_executions_ws_created');
    expect(text, text).not.toContain('Sort');
  });
});
