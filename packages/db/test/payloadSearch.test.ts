import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createPool,
  createVersion,
  createWorkflow,
  DEFAULT_WORKSPACE_ID,
  escapeLikePattern,
  MIN_SEARCH_LENGTH,
  runMigrations,
  searchExecutionsByPayload,
} from '../src/index.js';

let pool: Pool;
let workflowId: string;
let versionId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  const wf = await createWorkflow(pool, { workspaceId: DEFAULT_WORKSPACE_ID, name: 'Search' });
  workflowId = wf.id;
  versionId = (await createVersion(pool, { workflowId, definition: { schemaVersion: '0.1' }, hash: 's' })).id;
  await pool.query(`DELETE FROM executions WHERE workflow_id = $1`, [workflowId]);
  await pool.query(`DELETE FROM trigger_events WHERE workflow_id = $1`, [workflowId]);
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM executions WHERE workflow_id = $1`, [workflowId]);
  await pool.query(`DELETE FROM trigger_events WHERE workflow_id = $1`, [workflowId]);
  await pool.end();
});

/** A run started by a webhook carrying `payload`. */
async function runWith(payload: unknown, key: string): Promise<string> {
  const t = await pool.query<{ id: string }>(
    `INSERT INTO trigger_events (workspace_id, workflow_id, node_id, idempotency_key, payload_json)
     VALUES ($1, $2, 'hook', $3, $4) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, workflowId, key, JSON.stringify(payload)],
  );
  const e = await pool.query<{ id: string }>(
    `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, trigger_event_id)
     VALUES ($1, $2, $3, 'SUCCEEDED', $4) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, workflowId, versionId, t.rows[0]!.id],
  );
  return e.rows[0]!.id;
}

const search = (query: string, limit = 20) =>
  searchExecutionsByPayload(pool, { workspaceId: DEFAULT_WORKSPACE_ID, query, limit });

describe('escapeLikePattern', () => {
  test('neutralises the characters ILIKE treats as wildcards', () => {
    // A search for `50%` would otherwise match everything after "50", and a lone `%`
    // would match every row in the workspace — a scan somebody asks for by accident.
    expect(escapeLikePattern('50%')).toBe('50\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  test('escapes the backslash first, or it would escape the escapes', () => {
    expect(escapeLikePattern('a\\%')).toBe('a\\\\\\%');
  });

  test('leaves ordinary text alone', () => {
    expect(escapeLikePattern('INV-20260811-0042')).toBe('INV-20260811-0042');
  });
});

describe('searchExecutionsByPayload', () => {
  test('finds the run that handled an order number', async () => {
    // The support question this exists for. Status filtering does not help: the run is
    // usually SUCCEEDED, sitting among hundreds of others.
    const wanted = await runWith({ body: { order_id: 'INV-20260811-0042', total: 56000 } }, 'k1');
    await runWith({ body: { order_id: 'INV-20260811-0043', total: 12000 } }, 'k2');
    const hits = await search('INV-20260811-0042');
    expect(hits.map((h) => h.executionId)).toEqual([wanted]);
  });

  test('matches anywhere in the body, not just a known path', async () => {
    // The operator has an order number, not a JSON path.
    const wanted = await runWith({ body: { customer: { phone: '628123456789' } } }, 'k3');
    expect((await search('628123456789')).map((h) => h.executionId)).toContain(wanted);
  });

  test('is case-insensitive, because nobody types an email back exactly', async () => {
    const wanted = await runWith({ body: { email: 'Siti.Rahmawati@example.com' } }, 'k4');
    expect((await search('siti.rahmawati')).map((h) => h.executionId)).toContain(wanted);
  });

  test('a percent sign is text, not a wildcard', async () => {
    // Without escaping, searching `50%` matches every payload containing "50".
    const wanted = await runWith({ body: { discount: '50% off' } }, 'k5');
    await runWith({ body: { total: 5000 } }, 'k6');
    const hits = await search('50%');
    expect(hits.map((h) => h.executionId)).toEqual([wanted]);
  });

  test('a lone wildcard matches nothing rather than everything', async () => {
    await runWith({ body: { a: 1 } }, 'k7');
    expect(await search('%%%')).toEqual([]);
  });

  test('returns execution metadata and NEVER the matched body', async () => {
    // The caller needs execution:run to search, and the same permission gates reading a
    // payload — but echoing the body into a list view puts customer data on a screen
    // somebody leaves open.
    await runWith({ body: { secret_note: 'CUSTOMER-PRIVATE-DATA' } }, 'k8');
    const dump = JSON.stringify(await search('CUSTOMER-PRIVATE'));
    expect(dump).not.toContain('CUSTOMER-PRIVATE-DATA');
    expect(dump).toContain('SUCCEEDED');
  });

  test('another workspace finds nothing of ours', async () => {
    await runWith({ body: { order_id: 'INV-ISOLATED-0001' } }, 'k9');
    const other = await searchExecutionsByPayload(pool, {
      workspaceId: '00000000-0000-0000-0000-0000000000ff',
      query: 'INV-ISOLATED-0001',
      limit: 20,
    });
    expect(other).toEqual([]);
  });

  test('respects the limit and returns newest first', async () => {
    for (let i = 0; i < 4; i += 1) await runWith({ body: { tag: 'BULKTAG' } }, `k10-${i}`);
    const hits = await search('BULKTAG', 2);
    expect(hits).toHaveLength(2);
    expect(new Date(hits[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(hits[1]!.createdAt).getTime(),
    );
  });

  test('a run with no trigger event is not a match', async () => {
    // Runs started through /execute have no webhook body to search.
    await pool.query(
      `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status)
       VALUES ($1, $2, $3, 'SUCCEEDED')`,
      [DEFAULT_WORKSPACE_ID, workflowId, versionId],
    );
    expect(await search('SUCCEEDED')).toEqual([]);
  });
});

describe('the trigram index is what makes the minimum length real', () => {
  /** Trigrams with no padding space — the only kind an infix `%…%` match can look up. */
  async function usableTrigrams(text: string): Promise<string[]> {
    const r = await pool.query<{ t: string[] }>(`SELECT show_trgm($1) AS t`, [text]);
    return r.rows[0]!.t.filter((t) => !t.includes(' '));
  }

  test(`${MIN_SEARCH_LENGTH - 1} characters yield no usable trigram, which is why the minimum exists`, async () => {
    // Measured against pg_trgm rather than against a query plan. Two characters produce
    // only PADDED trigrams — "  9", " 99", "99 " — and padding only matches at a word
    // boundary, so an infix search has nothing to look up and Postgres reads every
    // webhook body in the table. Three characters produce a real one.
    //
    // Asserted this way on purpose: an earlier version of this test compared EXPLAIN
    // output and was measuring the planner's cost estimates, which move with statistics.
    expect(await usableTrigrams('99')).toEqual([]);
    expect(await usableTrigrams('234')).toContain('234');
  });

  test('the index the search depends on actually exists', async () => {
    const r = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_trigger_events_payload_trgm'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.indexdef).toContain('gin_trgm_ops');
  });

  test('a search stays correct at volume, not just on three rows', async () => {
    await pool.query(
      `INSERT INTO trigger_events (workspace_id, workflow_id, node_id, idempotency_key, payload_json, received_at)
       SELECT $1, $2, 'hook', 'vol-' || i,
              jsonb_build_object('body', jsonb_build_object('order_id', 'INV-2026-' || lpad(i::text, 6, '0'))),
              now() - make_interval(mins => i)
         FROM generate_series(1, 2000) AS i`,
      [DEFAULT_WORKSPACE_ID, workflowId],
    );
    await pool.query('ANALYZE trigger_events');
    // These rows have no execution attached, so they must NOT surface as matches: the
    // search answers "which run handled this", and a body with no run is not an answer.
    expect(await search('INV-2026-001234')).toEqual([]);
  }, 60000);
});
