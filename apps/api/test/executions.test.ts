import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';
import { leadCheckIr } from './fixtures.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

async function publishedWorkflow(): Promise<string> {
  const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'Lead' } });
  const id = created.json<{ id: string }>().id;
  await auth.inject({
    method: 'PUT',
    url: `/v1/workflows/${id}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition: leadCheckIr() },
  });
  await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
  return id;
}

describe('node payloads on the detail response', () => {
  /** Runs a node to SUCCEEDED with a payload carrying a secret-shaped key. */
  async function executionWithPayload(): Promise<string> {
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: { name: 'Budi' } });
    const executionId = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `UPDATE execution_nodes SET status = 'SUCCEEDED', input_json = $2, output_json = $3
       WHERE execution_id = $1 AND node_id = 't'`,
      [
        executionId,
        JSON.stringify({ url: 'https://api.test/v1', headers: { authorization: 'Bearer sk-live-999' } }),
        JSON.stringify({ status: 200, body: { ok: true } }),
      ],
    );
    return executionId;
  }

  test('the detail response never carries payloads, whatever the role', async () => {
    // It has no row limit and the UI polls it every two seconds; carrying payloads there
    // would re-read and re-serialise megabytes on a timer.
    const id = await executionWithPayload();
    const d = await auth.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const body = d.json<{ payloadsVisible: boolean; nodes: Record<string, unknown>[] }>();
    expect(body.payloadsVisible).toBe(true);
    for (const node of body.nodes) {
      expect(Object.keys(node)).not.toContain('inputJson');
      expect(Object.keys(node)).not.toContain('outputJson');
    }
    expect(JSON.stringify(d.json())).not.toContain('sk-live-999');
  });

  test('a member who can run fetches one attempt payload on demand', async () => {
    const id = await executionWithPayload();
    const d = await auth.inject({ method: 'GET', url: `/v1/executions/${id}/nodes/t/1/payload` });
    expect(d.statusCode).toBe(200);
    expect(d.json<{ outputJson: unknown }>().outputJson).toEqual({ status: 200, body: { ok: true } });
  });

  test('a secret-named parameter key is redacted on the way out', async () => {
    const id = await executionWithPayload();
    const d = await auth.inject({ method: 'GET', url: `/v1/executions/${id}/nodes/t/1/payload` });
    const input = d.json<{ inputJson: { headers?: { authorization?: string }; url?: string } }>().inputJson;
    expect(input.headers?.authorization).toBe('[redacted]');
    // Only the credential-shaped key, not the whole object.
    expect(input.url).toBe('https://api.test/v1');
    expect(JSON.stringify(d.json())).not.toContain('sk-live-999');
  });

  test('a viewer gets payloadsVisible false and is refused the payload route', async () => {
    // A viewer is a read-only observer. Handing it payloads would turn execution:read
    // into a transitive read of anything an author typed into a parameter.
    const id = await executionWithPayload();
    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    expect(viewer.inject).toBeDefined();
    const detail = await viewer.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(detail.json<{ payloadsVisible: boolean }>().payloadsVisible).toBe(false);
    const payload = await viewer.inject({ method: 'GET', url: `/v1/executions/${id}/nodes/t/1/payload` });
    expect(payload.statusCode).toBe(403);
    expect(JSON.stringify(payload.json())).not.toContain('sk-live-999');
  });

  test('an operator can see payloads, since it may start the run', async () => {
    const id = await executionWithPayload();
    const operator = await addMemberWithRole(app, pool, auth.workspaceId, 'operator');
    const d = await operator.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(d.json<{ payloadsVisible: boolean }>().payloadsVisible).toBe(true);
    expect((await operator.inject({ method: 'GET', url: `/v1/executions/${id}/nodes/t/1/payload` })).statusCode).toBe(
      200,
    );
  });

  test('the payload route is scoped to the workspace and rejects a bad path', async () => {
    const id = await executionWithPayload();
    const stranger = await createAuthedUser(app);
    // Another workspace's member must get 404, not another tenant's data.
    const other = await stranger.inject({ method: 'GET', url: `/v1/executions/${id}/nodes/t/1/payload` });
    expect(other.statusCode).toBe(404);
    // A legal attempt number that this node never reached is a 404 …
    expect((await auth.inject({ method: 'GET', url: `/v1/executions/${id}/nodes/t/9/payload` })).statusCode).toBe(404);
    // … while a malformed path or an attempt outside the legal range is a 400.
    expect((await auth.inject({ method: 'GET', url: `/v1/executions/not-a-uuid/nodes/t/1/payload` })).statusCode).toBe(
      400,
    );
    expect((await auth.inject({ method: 'GET', url: `/v1/executions/${id}/nodes/t/999/payload` })).statusCode).toBe(400);
  });

  test('a viewer never receives a resume URL', async () => {
    // POST /r/:resumeToken carries NO auth, so the URL IS the credential — anyone
    // holding it can drive the run and write that node's output. A viewer is denied
    // execution:run precisely so it cannot do that.
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: {} });
    const id = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `INSERT INTO execution_waits (workspace_id, execution_id, node_id, attempt, kind, status, resume_token)
       VALUES ($3, $1, 't', 1, 'event', 'open', $2)`,
      [id, 'resume-token-secret-abc', auth.workspaceId],
    );

    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const asViewer = await viewer.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(JSON.stringify(asViewer.json())).not.toContain('resume-token-secret-abc');
    for (const w of asViewer.json<{ waits: Record<string, unknown>[] }>().waits) {
      expect(Object.keys(w)).not.toContain('resumeUrl');
    }

    // An operator still gets it — the capability is gated, not removed.
    const asOwner = await auth.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const wait = asOwner.json<{ waits: { resumeUrl?: string }[] }>().waits.find((w) => w.resumeUrl);
    expect(wait?.resumeUrl).toContain('resume-token-secret-abc');
  });

  test('revealing a resume URL is audited', async () => {
    // The trigger-secret route audits every reveal on the grounds that handing out a
    // secret transfers a capability. This one transfers the same kind.
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: {} });
    const id = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `INSERT INTO execution_waits (workspace_id, execution_id, node_id, attempt, kind, status, resume_token)
       VALUES ($3, $1, 't', 1, 'event', 'open', $2)`,
      [id, 'audited-token-xyz', auth.workspaceId],
    );
    await auth.inject({ method: 'GET', url: `/v1/executions/${id}` });
    const audit = await pool.query(
      `SELECT action, target_id FROM audit_events WHERE action = 'execution_resume.reveal' AND target_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  test('an error payload is redacted for every role, not just for payload readers', async () => {
    // errorJson goes to everyone: an http.request failure carries the provider's full
    // response body, and an SSRF refusal carries the raw URL with its query string.
    const wf = await publishedWorkflow();
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${wf}/execute`, payload: {} });
    const id = r.json<{ executionId: string }>().executionId;
    await pool.query(
      `UPDATE execution_nodes SET status = 'FAILED', error_json = $2 WHERE execution_id = $1 AND node_id = 't'`,
      [id, JSON.stringify({ code: 'http_error', details: { body: { access_token: 'leaked-abc-123' } } })],
    );
    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const d = await viewer.inject({ method: 'GET', url: `/v1/executions/${id}` });
    expect(JSON.stringify(d.json())).not.toContain('leaked-abc-123');
  });
});

describe('execute and inspect', () => {
  test('execute creates a CREATED execution with PENDING nodes and outbox rows', async () => {
    const id = await publishedWorkflow();
    const r = await auth.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      payload: { name: 'Budi', total: 150 },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ executionId: string; status: string; created: boolean }>();
    expect(body.status).toBe('CREATED');
    expect(body.created).toBe(true);

    const detail = await auth.inject({ method: 'GET', url: `/v1/executions/${body.executionId}` });
    const d = detail.json<{ execution: { status: string }; nodes: { status: string }[]; events: unknown[] }>();
    expect(d.execution.status).toBe('CREATED');
    expect(d.nodes).toHaveLength(4); // t, branch, notify, archive
    expect(d.nodes.every((n) => n.status === 'PENDING')).toBe(true);

    const outbox = await pool.query(`SELECT event_type FROM task_outbox WHERE published_at IS NULL`);
    const types = (outbox.rows as { event_type: string }[]).map((x) => x.event_type).sort();
    expect(types).toEqual(['execution.requested', 'execution.watchdog']);
  });

  test('duplicate Idempotency-Key returns 200 with the same execution', async () => {
    const id = await publishedWorkflow();
    const first = await auth.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      headers: { 'idempotency-key': 'dup-1' },
      payload: { name: 'Budi' },
    });
    const second = await auth.inject({
      method: 'POST',
      url: `/v1/workflows/${id}/execute`,
      headers: { 'idempotency-key': 'dup-1' },
      payload: { name: 'Budi' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ executionId: string }>().executionId).toBe(
      first.json<{ executionId: string }>().executionId,
    );
  });

  test('execute without a published version is a 409 problem', async () => {
    const created = await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } });
    const id = created.json<{ id: string }>().id;
    const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/execute`, payload: {} });
    expect(r.statusCode).toBe(409);
  });

  test('executions list filters by workflowId', async () => {
    const id = await publishedWorkflow();
    for (let i = 0; i < 3; i += 1) {
      await auth.inject({
        method: 'POST',
        url: `/v1/workflows/${id}/execute`,
        headers: { 'idempotency-key': `k${i}` },
        payload: {},
      });
    }
    const r = await auth.inject({ method: 'GET', url: `/v1/executions?workflowId=${id}&limit=2` });
    const body = r.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
  });

  test('unknown execution is 404', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/executions/00000000-0000-0000-0000-0000000000bb' });
    expect(r.statusCode).toBe(404);
  });

  test('execute on unknown workflow is 404', async () => {
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/workflows/00000000-0000-0000-0000-0000000000cc/execute',
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });

  test('executions list rejects invalid query and follows cursors', async () => {
    const bad = await auth.inject({ method: 'GET', url: '/v1/executions?limit=0' });
    expect(bad.statusCode).toBe(400);
    const id = await publishedWorkflow();
    for (let i = 0; i < 3; i += 1) {
      await auth.inject({
        method: 'POST',
        url: `/v1/workflows/${id}/execute`,
        headers: { 'idempotency-key': `cur${i}` },
        payload: {},
      });
    }
    const all = await auth.inject({ method: 'GET', url: '/v1/executions?limit=2' });
    const page1 = all.json<{ items: unknown[]; nextCursor: string }>();
    const page2 = await auth.inject({
      method: 'GET',
      url: `/v1/executions?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
    });
    expect(page2.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  test('workflows list rejects invalid query', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/workflows?limit=0' });
    expect(r.statusCode).toBe(400);
  });
});

describe('executions list filtering', () => {
  /** Rows are written directly so status and age are exact rather than incidental. */
  async function seedRuns(): Promise<{ workflowId: string; failedId: string }> {
    const workflowId = await publishedWorkflow();
    const version = await pool.query<{ id: string }>(
      `SELECT id FROM workflow_versions WHERE workflow_id = $1 LIMIT 1`,
      [workflowId],
    );
    const versionId = version.rows[0]!.id;
    const ws = await pool.query<{ workspace_id: string }>(`SELECT workspace_id FROM workflows WHERE id = $1`, [
      workflowId,
    ]);
    const workspaceId = ws.rows[0]!.workspace_id;
    const insert = async (status: string, minutesAgo: number): Promise<string> => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, created_at)
         VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5)) RETURNING id`,
        [workspaceId, workflowId, versionId, status, minutesAgo],
      );
      return r.rows[0]!.id;
    };
    // The failure is the OLDEST row, so a client-side filter over the first page would
    // never see it. That was the actual bug.
    const failedId = await insert('FAILED', 900);
    for (let i = 0; i < 25; i += 1) await insert('SUCCEEDED', i);
    return { workflowId, failedId };
  }

  test('a failure older than the first page is still found', async () => {
    const { failedId } = await seedRuns();
    const r = await auth.inject({ method: 'GET', url: '/v1/executions?status=FAILED' });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ items: { id: string }[] }>().items.map((e) => e.id)).toEqual([failedId]);
  });

  test('several statuses in one request', async () => {
    await seedRuns();
    const r = await auth.inject({ method: 'GET', url: '/v1/executions?status=FAILED,SUCCEEDED&limit=100' });
    expect(r.json<{ items: unknown[] }>().items).toHaveLength(26);
  });

  test('an unknown status is a 400, not an empty page', async () => {
    // An empty page reads as "nothing matched" and sends an operator looking for a
    // problem that does not exist.
    const r = await auth.inject({ method: 'GET', url: '/v1/executions?status=BROKEN' });
    expect(r.statusCode).toBe(400);
  });

  test('an empty status parameter means no filter', async () => {
    await seedRuns();
    const r = await auth.inject({ method: 'GET', url: '/v1/executions?status=&limit=100' });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ items: unknown[] }>().items).toHaveLength(26);
  });

  test('a cursor from another filter is a 400 rather than the wrong page', async () => {
    await seedRuns();
    const first = await auth.inject({ method: 'GET', url: '/v1/executions?status=SUCCEEDED&limit=2' });
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    expect(cursor).toBeTruthy();
    const reused = await auth.inject({
      method: 'GET',
      url: `/v1/executions?limit=2&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(reused.statusCode).toBe(400);
  });

  test('the same filter pages forward normally', async () => {
    await seedRuns();
    const first = await auth.inject({ method: 'GET', url: '/v1/executions?status=SUCCEEDED&limit=2' });
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    const second = await auth.inject({
      method: 'GET',
      url: `/v1/executions?status=SUCCEEDED&limit=2&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(second.statusCode).toBe(200);
    const firstIds = first.json<{ items: { id: string }[] }>().items.map((e) => e.id);
    const secondIds = second.json<{ items: { id: string }[] }>().items.map((e) => e.id);
    expect(secondIds).toHaveLength(2);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  test('a garbage cursor is a 400', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/executions?cursor=not-a-cursor' });
    expect(r.statusCode).toBe(400);
  });
});

describe('bulk retry', () => {
  const setLimit = (ws: string, patch: Record<string, number | null>) =>
    pool.query(`UPDATE workspace_plans SET limit_overrides = $2 WHERE workspace_id = $1`, [
      ws,
      JSON.stringify(patch),
    ]);

  /** Failed runs the operator would want back after fixing whatever broke them. */
  async function seedFailures(count: number): Promise<{ workflowId: string; ids: string[] }> {
    const workflowId = await publishedWorkflow();
    const version = await pool.query<{ id: string }>(
      `SELECT id FROM workflow_versions WHERE workflow_id = $1 LIMIT 1`,
      [workflowId],
    );
    const ws = await pool.query<{ workspace_id: string }>(`SELECT workspace_id FROM workflows WHERE id = $1`, [
      workflowId,
    ]);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, status, created_at)
         VALUES ($1, $2, $3, 'FAILED', now() - make_interval(mins => $4)) RETURNING id`,
        [ws.rows[0]!.workspace_id, workflowId, version.rows[0]!.id, i],
      );
      ids.push(r.rows[0]!.id);
    }
    return { workflowId, ids };
  }

  const countRuns = async (workflowId: string): Promise<number> => {
    const r = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM executions WHERE workflow_id = $1`,
      [workflowId],
    );
    return Number(r.rows[0]!.count);
  };

  test('a dry run counts without creating anything', async () => {
    // The count is what an operator needs before committing to spending quota, and it
    // costs one query.
    const { workflowId } = await seedFailures(3);
    const before = await countRuns(workflowId);
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/executions/retry',
      payload: { workflowId, dryRun: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dryRun: true, matched: 3, retried: 0 });
    expect(await countRuns(workflowId)).toBe(before);
  });

  test('retries every matching failure and leaves successes alone', async () => {
    const { workflowId } = await seedFailures(3);
    await pool.query(`UPDATE executions SET status = 'SUCCEEDED' WHERE workflow_id = $1 AND status = 'FAILED'
                      AND id IN (SELECT id FROM executions WHERE workflow_id = $1 LIMIT 1)`, [workflowId]);
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/executions/retry',
      payload: { workflowId },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ retried: 2, skipped: 0, stoppedForQuota: false });
    // Two new runs, so five rows where there were three.
    expect(await countRuns(workflowId)).toBe(5);
  });

  test('defaults to the failure statuses rather than everything', async () => {
    // "Retry everything" has no honest meaning — re-running a success duplicates work
    // that already happened.
    const { workflowId } = await seedFailures(2);
    await pool.query(`UPDATE executions SET status = 'SUCCEEDED' WHERE workflow_id = $1`, [workflowId]);
    const r = await auth.inject({ method: 'POST', url: '/v1/executions/retry', payload: { workflowId } });
    expect(r.json()).toMatchObject({ matched: 0, retried: 0 });
  });

  test('an empty status list is refused, not treated as "all"', async () => {
    const r = await auth.inject({ method: 'POST', url: '/v1/executions/retry', payload: { status: [] } });
    expect(r.statusCode).toBe(400);
  });

  test('the batch is capped, so it cannot replay a month with one click', async () => {
    const over = await auth.inject({ method: 'POST', url: '/v1/executions/retry', payload: { limit: 101 } });
    expect(over.statusCode).toBe(400);
    const { workflowId } = await seedFailures(4);
    const r = await auth.inject({
      method: 'POST',
      url: '/v1/executions/retry',
      payload: { workflowId, limit: 2 },
    });
    expect(r.json()).toMatchObject({ matched: 2, retried: 2 });
  });

  test('stops at the first quota refusal and REPORTS the partial', async () => {
    // Quietly doing two of four and answering 200 would be a lie the operator only
    // discovers from the invoice.
    const { workflowId } = await seedFailures(4);
    const ws = await pool.query<{ workspace_id: string }>(`SELECT workspace_id FROM workflows WHERE id = $1`, [
      workflowId,
    ]);
    // Four seeded runs already count against the cap, so five allows exactly one retry.
    await setLimit(ws.rows[0]!.workspace_id, { executionsPerMonth: 5 });
    const r = await auth.inject({ method: 'POST', url: '/v1/executions/retry', payload: { workflowId } });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ retried: number; stoppedForQuota: boolean }>();
    expect(body.stoppedForQuota).toBe(true);
    expect(body.retried).toBeLessThan(4);
    await setLimit(ws.rows[0]!.workspace_id, {});
  });

  test('writes one audit row for the batch, not one per execution', async () => {
    // Per-run rows would bury the fact that a human did this once, deliberately.
    await pool.query(`DELETE FROM audit_events WHERE action = 'execution.retry_batch'`);
    const { workflowId } = await seedFailures(3);
    await auth.inject({ method: 'POST', url: '/v1/executions/retry', payload: { workflowId } });
    const rows = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'execution.retry_batch'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.metadata).toMatchObject({ retried: 3, matched: 3 });
  });

  test('a viewer may not bulk retry', async () => {
    const viewer = await addMemberWithRole(app, pool, auth.workspaceId, 'viewer');
    const r = await viewer.inject({ method: 'POST', url: '/v1/executions/retry', payload: {} });
    expect(r.statusCode).toBe(403);
  });

  test('another workspace retries nothing of ours', async () => {
    const { workflowId } = await seedFailures(2);
    const before = await countRuns(workflowId);
    const other = await createAuthedUser(app);
    const r = await other.inject({ method: 'POST', url: '/v1/executions/retry', payload: {} });
    expect(r.json()).toMatchObject({ matched: 0, retried: 0 });
    expect(await countRuns(workflowId)).toBe(before);
  });
});
