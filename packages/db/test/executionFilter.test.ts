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
   * `enable_seqscan = off` on purpose.
   *
   * On a near-empty test table the planner picks a sequential scan whatever indexes
   * exist, so a plain EXPLAIN would pass with no index at all and fail once someone adds
   * rows. Forcing the choice answers the question that actually matters — is there an
   * index that CAN serve this predicate and ordering — rather than what today's
   * statistics happen to prefer.
   */
  async function forcedPlan(sql: string, params: unknown[]): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
      return plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  test('one status lands in the Index Cond, not a Filter', async () => {
    // Measured, and it drove the query builder: `status = ANY('{FAILED}')` makes Postgres
    // read (workspace_id, created_at) and FILTER on status — scanning the whole history
    // to find the rare failures. Scalar equality puts status in the index condition.
    const text = await forcedPlan(
      `SELECT * FROM executions WHERE workspace_id = $1 AND status = $2
        ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID, 'FAILED'],
    );
    expect(text, text).toContain('idx_executions_ws_status_created');
    expect(text, text).toMatch(/Index Cond:.*status/s);
  });

  test('an array predicate would NOT use that index, which is why it is avoided', async () => {
    const text = await forcedPlan(
      `SELECT * FROM executions WHERE workspace_id = $1 AND status = ANY($2::text[])
        ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID, ['FAILED']],
    );
    expect(text, text).not.toContain('idx_executions_ws_status_created');
  });

  test('several statuses still read in index order rather than sorting', async () => {
    // The index orders by status first, so two statuses cannot share one ordered scan.
    // Reading the created_at index and filtering is the right plan; a Sort is not.
    const text = await forcedPlan(
      `SELECT * FROM executions WHERE workspace_id = $1 AND status = ANY($2::text[])
        ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID, ['FAILED', 'TIMED_OUT']],
    );
    expect(text, text).toContain('idx_executions_ws_created');
    expect(text, text).not.toContain('Sort');
  });

  test('the unfiltered list is index-served too', async () => {
    const text = await forcedPlan(
      `SELECT * FROM executions WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 21`,
      [DEFAULT_WORKSPACE_ID],
    );
    expect(text, text).toContain('idx_executions_ws_created');
  });
});
