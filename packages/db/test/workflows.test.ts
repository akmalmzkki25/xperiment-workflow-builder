import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, runMigrations } from '../src/index.js';
import {
  createVersion,
  createWorkflow,
  getDraft,
  getVersion,
  getWorkflow,
  listWorkflows,
  updateDraft,
} from '../src/repos/workflows.js';

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

describe('workflow repos', () => {
  test('createWorkflow creates row plus empty draft at revision 1', async () => {
    const wf = await createWorkflow(pool, { name: 'Lead check' });
    expect(wf.name).toBe('Lead check');
    expect(wf.draftRevision).toBe(1);
    const draft = await getDraft(pool, wf.id);
    expect(draft).toEqual({ definition: {}, revision: 1 });
    const got = await getWorkflow(pool, wf.id);
    expect(got?.status).toBe('draft');
    expect(got?.activeVersionId).toBeNull();
  });

  test('updateDraft succeeds with matching revision, conflicts otherwise', async () => {
    const wf = await createWorkflow(pool, { name: 'X' });
    const def = { schemaVersion: '0.1' };
    const rev2 = await updateDraft(pool, { workflowId: wf.id, definition: def, expectedRevision: 1 });
    expect(rev2).toBe(2);
    const conflict = await updateDraft(pool, { workflowId: wf.id, definition: def, expectedRevision: 1 });
    expect(conflict).toBeNull();
    const draft = await getDraft(pool, wf.id);
    expect(draft?.revision).toBe(2);
  });

  test('createVersion numbers monotonically and activates', async () => {
    const wf = await createWorkflow(pool, { name: 'X' });
    const v1 = await createVersion(pool, { workflowId: wf.id, definition: { a: 1 }, hash: 'h1' });
    const v2 = await createVersion(pool, { workflowId: wf.id, definition: { a: 2 }, hash: 'h2' });
    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);
    const got = await getWorkflow(pool, wf.id);
    expect(got?.activeVersionId).toBe(v2.id);
    expect(got?.status).toBe('published');
    const loaded = await getVersion(pool, v2.id);
    expect(loaded?.definition).toEqual({ a: 2 });
    expect(loaded?.workflowId).toBe(wf.id);
  });

  test('listWorkflows paginates with cursor', async () => {
    for (let i = 0; i < 5; i += 1) await createWorkflow(pool, { name: `wf-${i}` });
    const page1 = await listWorkflows(pool, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listWorkflows(pool, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    const ids = new Set([...page1.items, ...page2.items].map((w) => w.id));
    expect(ids.size).toBe(4);
  });
});
