# Version Diff & Rollback (Phase 2 Sub-project K) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare any two workflow versions (or a draft vs a version) as a semantic diff, and roll a workflow back by re-publishing an old version's IR as a new immutable version.

**Architecture:** A pure `diffWorkflows` in `@xperiment/ir` (node/edge added/removed/modified, layout-agnostic). Two read/append API routes on `workflows.ts`: `GET …/diff?from&to` and `POST …/versions/:versionId/rollback` (reuses the existing `createVersion`). A dedicated web version-history + diff page.

**Tech Stack:** pnpm monorepo, TS ESM via tsx, Vitest (v8 coverage ≥80%), Fastify, Next.js (Arus).

## Global Constraints

- Never hardcode secrets; no `console.log`. TDD: failing test first. Coverage ≥80% every metric per package.
- Immutability; focused files. Conventional commits `<type>: <description>`, NO attribution trailer.
- `WorkflowIR` = `{ schemaVersion, workflow, entrypoints, nodes: IRNode[], edges: IREdge[], metadata? }`.
  `IRNode = { id, kind, type, operationVersion, parameters, settings?, effectClass?, connectionRef? }`.
  `IREdge = { id, from: {nodeId, port}, to: {nodeId, port} }`.
- Diff ignores `metadata.layout`/positions. Rollback only ever appends a version (history immutable).
- Reuse: `createVersion(pool, { workflowId, definition, hash })`, `getVersion`, `getWorkflow`, `workflowIrSchema` (@xperiment/ir).
- Branch `feature/phase2-version-diff` is checked out; the spec is committed. Docker Postgres/Redis running.

---

### Task K-1: @xperiment/ir — diffWorkflows

**Files:**
- Create: `packages/ir/src/diff.ts`
- Modify: `packages/ir/src/index.ts` (export)
- Test: `packages/ir/test/diff.test.ts`

**Interfaces:**
- Consumes: `WorkflowIR`, `IRNode`, `IREdge` from `./types.js`.
- Produces:
  - `interface NodeModification { nodeId: string; changedFields: string[] }`
  - `interface EdgeModification { edgeId: string }`
  - `interface WorkflowDiff { nodes: { added: string[]; removed: string[]; modified: NodeModification[] }; edges: { added: string[]; removed: string[]; modified: EdgeModification[] }; changed: boolean }`
  - `diffWorkflows(from: WorkflowIR, to: WorkflowIR): WorkflowDiff`

- [ ] **Step 1: Write the failing test**

Create `packages/ir/test/diff.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { diffWorkflows } from '../src/diff.js';
import type { WorkflowIR } from '../src/types.js';

const base: WorkflowIR = {
  schemaVersion: '0.1',
  workflow: { id: 'wf', name: 'W' },
  entrypoints: ['t'],
  nodes: [
    { id: 't', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'none' } },
    { id: 'a', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: true } } },
  ],
  edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'a', port: 'input' } }],
};
const clone = (ir: WorkflowIR): WorkflowIR => JSON.parse(JSON.stringify(ir)) as WorkflowIR;

describe('diffWorkflows', () => {
  test('identical IRs report no changes', () => {
    const d = diffWorkflows(base, clone(base));
    expect(d.changed).toBe(false);
    expect(d.nodes).toEqual({ added: [], removed: [], modified: [] });
    expect(d.edges).toEqual({ added: [], removed: [], modified: [] });
  });

  test('added and removed nodes', () => {
    const to = clone(base);
    to.nodes.push({ id: 'b', kind: 'action', type: 'http.request', operationVersion: '0.1.0', parameters: {} });
    to.nodes = to.nodes.filter((n) => n.id !== 'a');
    const d = diffWorkflows(base, to);
    expect(d.nodes.added).toEqual(['b']);
    expect(d.nodes.removed).toEqual(['a']);
    expect(d.changed).toBe(true);
  });

  test('modified node reports only the changed fields (params-only, key-order stable)', () => {
    const to = clone(base);
    to.nodes[1]!.parameters = { fields: { ok: false } };
    const d = diffWorkflows(base, to);
    expect(d.nodes.modified).toEqual([{ nodeId: 'a', changedFields: ['parameters'] }]);

    const reordered = clone(base);
    reordered.nodes[0]!.parameters = { authMode: 'none' }; // same content, treated equal
    expect(diffWorkflows(base, reordered).changed).toBe(false);
  });

  test('type + connectionRef changes are listed', () => {
    const to = clone(base);
    to.nodes[1]!.type = 'postgres.query';
    to.nodes[1]!.connectionRef = 'conn-1';
    const d = diffWorkflows(base, to);
    expect(d.nodes.modified[0]!.changedFields.sort()).toEqual(['connectionRef', 'type']);
  });

  test('edge added / removed / rewired', () => {
    const added = clone(base);
    added.edges.push({ id: 'e2', from: { nodeId: 'a', port: 'main' }, to: { nodeId: 't', port: 'input' } });
    expect(diffWorkflows(base, added).edges.added).toEqual(['e2']);

    const removed = clone(base);
    removed.edges = [];
    expect(diffWorkflows(base, removed).edges.removed).toEqual(['e1']);

    const rewired = clone(base);
    rewired.edges[0]!.to = { nodeId: 'a', port: 'other' };
    expect(diffWorkflows(base, rewired).edges.modified).toEqual([{ edgeId: 'e1' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/ir test -- diff.test.ts`
Expected: FAIL — `diffWorkflows` not found.

- [ ] **Step 3: Implement**

Create `packages/ir/src/diff.ts`:

```ts
import type { IRNode, WorkflowIR } from './types.js';

export interface NodeModification {
  nodeId: string;
  changedFields: string[];
}
export interface EdgeModification {
  edgeId: string;
}
export interface WorkflowDiff {
  nodes: { added: string[]; removed: string[]; modified: NodeModification[] };
  edges: { added: string[]; removed: string[]; modified: EdgeModification[] };
  changed: boolean;
}

/** Deterministic JSON with recursively sorted object keys, so parameter key
 * ordering never registers as a change. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function nodeChangedFields(a: IRNode, b: IRNode): string[] {
  const fields: string[] = [];
  if (a.kind !== b.kind) fields.push('kind');
  if (a.type !== b.type) fields.push('type');
  if (a.operationVersion !== b.operationVersion) fields.push('operationVersion');
  if ((a.connectionRef ?? null) !== (b.connectionRef ?? null)) fields.push('connectionRef');
  if (stableStringify(a.parameters ?? {}) !== stableStringify(b.parameters ?? {})) fields.push('parameters');
  return fields;
}

export function diffWorkflows(from: WorkflowIR, to: WorkflowIR): WorkflowDiff {
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));
  const nAdded: string[] = [];
  const nRemoved: string[] = [];
  const nModified: NodeModification[] = [];
  for (const id of toNodes.keys()) if (!fromNodes.has(id)) nAdded.push(id);
  for (const [id, a] of fromNodes) {
    const b = toNodes.get(id);
    if (!b) {
      nRemoved.push(id);
      continue;
    }
    const changedFields = nodeChangedFields(a, b);
    if (changedFields.length > 0) nModified.push({ nodeId: id, changedFields });
  }

  const fromEdges = new Map(from.edges.map((e) => [e.id, e]));
  const toEdges = new Map(to.edges.map((e) => [e.id, e]));
  const eAdded: string[] = [];
  const eRemoved: string[] = [];
  const eModified: EdgeModification[] = [];
  for (const id of toEdges.keys()) if (!fromEdges.has(id)) eAdded.push(id);
  for (const [id, a] of fromEdges) {
    const b = toEdges.get(id);
    if (!b) {
      eRemoved.push(id);
      continue;
    }
    if (a.from.nodeId !== b.from.nodeId || a.from.port !== b.from.port || a.to.nodeId !== b.to.nodeId || a.to.port !== b.to.port) {
      eModified.push({ edgeId: id });
    }
  }

  const changed =
    nAdded.length + nRemoved.length + nModified.length + eAdded.length + eRemoved.length + eModified.length > 0;
  return {
    nodes: { added: nAdded, removed: nRemoved, modified: nModified },
    edges: { added: eAdded, removed: eRemoved, modified: eModified },
    changed,
  };
}
```

Add to `packages/ir/src/index.ts`:

```ts
export { diffWorkflows } from './diff.js';
export type { WorkflowDiff, NodeModification, EdgeModification } from './diff.js';
```

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

```bash
pnpm --filter @xperiment/ir test && pnpm --filter @xperiment/ir typecheck
git add packages/ir/src/diff.ts packages/ir/src/index.ts packages/ir/test/diff.test.ts
git commit -m "feat: add pure diffWorkflows to @xperiment/ir"
```

---

### Task K-2: DB getVersion hash + API diff & rollback routes

**Files:**
- Modify: `packages/db/src/repos/workflows.ts` (`getVersion` returns `definitionHash`)
- Modify: `apps/api/src/routes/workflows.ts` (two routes)
- Modify: `apps/api/src/openapi.ts` (paths)
- Test: `apps/api/test/versionDiff.test.ts` (new)

**Interfaces:**
- Consumes: `diffWorkflows`, `workflowIrSchema` (@xperiment/ir); `getWorkflow`, `getVersion`, `createVersion` (@xperiment/db); `authOf`, `roleGate`; `sendProblem`.
- Produces: `GET /v1/workflows/:id/diff?from&to`; `POST /v1/workflows/:id/versions/:versionId/rollback`.

- [ ] **Step 1: Extend getVersion**

In `packages/db/src/repos/workflows.ts`, add `definitionHash` to `getVersion`'s return type and mapping:

```ts
export async function getVersion(
  db: Db,
  id: string,
): Promise<{ id: string; workflowId: string; versionNumber: number; definition: unknown; definitionHash: string } | null> {
  const r = await db.query(`SELECT * FROM workflow_versions WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    id: row['id'] as string,
    workflowId: row['workflow_id'] as string,
    versionNumber: Number(row['version_number']),
    definition: row['definition_json'],
    definitionHash: row['definition_hash'] as string,
  };
}
```

Run `pnpm --filter @xperiment/db typecheck` — existing callers ignore the extra field, so this is additive.

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/versionDiff.test.ts`:

```ts
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;

const ir = (transformOk: boolean) => ({
  schemaVersion: '0.1',
  workflow: { id: 'wf', name: 'W' },
  entrypoints: ['t'],
  nodes: [
    { id: 't', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'none' } },
    { id: 'a', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: transformOk } } },
  ],
  edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'a', port: 'input' } }],
});

async function publish(id: string, definition: unknown, revision: number): Promise<void> {
  await auth.inject({ method: 'PUT', url: `/v1/workflows/${id}/draft`, payload: { definition }, headers: { 'if-match': String(revision) } });
  const r = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
  expect(r.statusCode).toBe(200);
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('version diff + rollback', () => {
  test('diffs two versions and a draft against a version, then rolls back', async () => {
    const wf = (await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'V' } })).json<{ id: string; draftRevision: number }>();
    const id = wf.id;
    await publish(id, ir(true), wf.draftRevision); // v1
    const detail1 = (await auth.inject({ method: 'GET', url: `/v1/workflows/${id}` })).json<{ draftRevision: number; versions: { id: string; versionNumber: number }[] }>();
    const v1 = detail1.versions[0]!;
    await publish(id, ir(false), detail1.draftRevision); // v2 (transform param changed)
    const detail2 = (await auth.inject({ method: 'GET', url: `/v1/workflows/${id}` })).json<{ draftRevision: number; versions: { id: string; versionNumber: number }[] }>();
    const v2 = detail2.versions.find((v) => v.versionNumber === 2)!;

    const diff = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/diff?from=${v1.id}&to=${v2.id}` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json<{ diff: { nodes: { modified: { nodeId: string }[] } } }>().diff.nodes.modified).toEqual([{ nodeId: 'a', changedFields: ['parameters'] }]);

    // draft (currently ir(false) from the last publish) vs v1 also shows the change
    const draftDiff = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/diff?from=draft&to=${v1.id}` });
    expect(draftDiff.statusCode).toBe(200);
    expect(draftDiff.json<{ diff: { changed: boolean } }>().diff.changed).toBe(true);

    // rollback to v1 → a new active version equal to v1
    const rb = await auth.inject({ method: 'POST', url: `/v1/workflows/${id}/versions/${v1.id}/rollback` });
    expect(rb.statusCode).toBe(201);
    expect(rb.json<{ versionNumber: number; rolledBackFrom: number }>().versionNumber).toBe(3);
    expect(rb.json<{ rolledBackFrom: number }>().rolledBackFrom).toBe(1);
    // the diff between v1 and the new v3 is empty
    const detail3 = (await auth.inject({ method: 'GET', url: `/v1/workflows/${id}` })).json<{ versions: { id: string; versionNumber: number }[] }>();
    const v3 = detail3.versions.find((v) => v.versionNumber === 3)!;
    const rbDiff = await auth.inject({ method: 'GET', url: `/v1/workflows/${id}/diff?from=${v1.id}&to=${v3.id}` });
    expect(rbDiff.json<{ diff: { changed: boolean } }>().diff.changed).toBe(false);
  });

  test('rejects a foreign version ref and a missing draft', async () => {
    const wfA = (await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'A' } })).json<{ id: string; draftRevision: number }>();
    await publish(wfA.id, ir(true), wfA.draftRevision);
    const vA = (await auth.inject({ method: 'GET', url: `/v1/workflows/${wfA.id}` })).json<{ versions: { id: string }[] }>().versions[0]!;

    const wfB = (await auth.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'B' } })).json<{ id: string; draftRevision: number }>();
    await publish(wfB.id, ir(true), wfB.draftRevision);

    // vA belongs to workflow A, not B → 400 foreign_version
    const foreign = await auth.inject({ method: 'GET', url: `/v1/workflows/${wfB.id}/diff?from=${vA.id}&to=${vA.id}` });
    expect(foreign.statusCode).toBe(400);

    // rollback of a foreign version → 404
    const rbForeign = await auth.inject({ method: 'POST', url: `/v1/workflows/${wfB.id}/versions/${vA.id}/rollback` });
    expect(rbForeign.statusCode).toBe(404);

    // no_draft branch: remove B's draft row, then a draft diff is 400
    await pool.query(`DELETE FROM workflow_drafts WHERE workflow_id = $1`, [wfB.id]);
    const noDraft = await auth.inject({ method: 'GET', url: `/v1/workflows/${wfB.id}/diff?from=draft&to=draft` });
    expect(noDraft.statusCode).toBe(400);
  });

  test('cross-workspace diff is 404', async () => {
    const other = await createAuthedUser(app);
    const wf = (await other.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } })).json<{ id: string; draftRevision: number }>();
    await other.inject({ method: 'PUT', url: `/v1/workflows/${wf.id}/draft`, payload: { definition: ir(true) }, headers: { 'if-match': String(wf.draftRevision) } });
    await other.inject({ method: 'POST', url: `/v1/workflows/${wf.id}/publish` });
    const r = await auth.inject({ method: 'GET', url: `/v1/workflows/${wf.id}/diff?from=draft&to=draft` });
    expect(r.statusCode).toBe(404); // not auth's workspace
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @xperiment/api test -- versionDiff.test.ts`
Expected: FAIL — routes not registered (404 on diff).

- [ ] **Step 4: Implement the routes**

In `apps/api/src/routes/workflows.ts`: add `getVersion` to the existing `@xperiment/db` import (it already imports `createVersion`, `getDraft`, `getWorkflow`) and add `diffWorkflows`, `workflowIrSchema` to the existing `@xperiment/ir` import (it already imports `canonicalHash`, `validateWorkflow`, `WorkflowIR`). Add inside `registerWorkflowRoutes`:

```ts
  app.get('/v1/workflows/:id/diff', async (req, reply) => {
    const ctx = authOf(req);
    const { id } = req.params as { id: string };
    const { from, to } = (req.query ?? {}) as { from?: string; to?: string };
    if (!from || !to) return sendProblem(reply, 400, 'Missing from/to', 'Both from and to are required');
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');

    const resolve = async (ref: string): Promise<{ label: string; ir: unknown } | { error: string }> => {
      if (ref === 'draft') {
        const draft = await getDraft(deps.pool, id);
        if (!draft) return { error: 'no_draft' };
        return { label: 'draft', ir: draft.definition };
      }
      const v = await getVersion(deps.pool, ref);
      if (!v || v.workflowId !== id) return { error: 'foreign_version' };
      return { label: String(v.versionNumber), ir: v.definition };
    };
    const a = await resolve(from);
    if ('error' in a) return sendProblem(reply, 400, 'Invalid from', a.error);
    const b = await resolve(to);
    if ('error' in b) return sendProblem(reply, 400, 'Invalid to', b.error);
    const fromIr = workflowIrSchema.parse(a.ir);
    const toIr = workflowIrSchema.parse(b.ir);
    return { from: a.label, to: b.label, diff: diffWorkflows(fromIr, toIr) };
  });

  app.post('/v1/workflows/:id/versions/:versionId/rollback', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const { id, versionId } = req.params as { id: string; versionId: string };
    const wf = await getWorkflow(deps.pool, id, ctx.workspaceId);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const version = await getVersion(deps.pool, versionId);
    if (!version || version.workflowId !== id) return sendProblem(reply, 404, 'Version not found');
    const created = await createVersion(deps.pool, { workflowId: id, definition: version.definition, hash: version.definitionHash });
    return reply.status(201).send({ ...created, rolledBackFrom: version.versionNumber });
  });
```

> Note: `getWorkflow` returns a `WorkflowRow` without the draft body; the draft
> definition is loaded separately via `getDraft(deps.pool, id)` (returns
> `{ definition, revision } | null`), as used above. `workflowIrSchema` is exported
> from `@xperiment/ir` (same import the executions route uses).

Register the OpenAPI paths in `apps/api/src/openapi.ts`:

```ts
    '/v1/workflows/{id}/diff': { get: { summary: 'Diff two versions or a draft (from/to = version id or "draft")', tags: ['workflows'] } },
    '/v1/workflows/{id}/versions/{versionId}/rollback': { post: { summary: 'Roll back: publish an old version forward as a new version', tags: ['workflows'] } },
```

- [ ] **Step 5: Run to verify it passes + typecheck + commit**

```bash
pnpm --filter @xperiment/api test -- versionDiff.test.ts && pnpm --filter @xperiment/api typecheck && pnpm --filter @xperiment/db typecheck
git add packages/db/src/repos/workflows.ts apps/api/src/routes/workflows.ts apps/api/src/openapi.ts apps/api/test/versionDiff.test.ts
git commit -m "feat: add version diff + rollback API"
```

---

### Task K-3: Web version-history + diff page

**Files:**
- Create: `apps/web/src/app/(app)/workflows/[id]/versions/page.tsx`
- Modify: `apps/web/src/lib/api.ts` (`getDiff`, `rollbackVersion` + `WorkflowDiff` type)
- Modify: `apps/web/src/app/(app)/workflows/page.tsx` (a "History" link per row)
- Test: `apps/web/test/api.test.ts` (matrix)

**Interfaces:**
- Consumes: `GET /v1/workflows/:id/diff?from&to`, `POST /v1/workflows/:id/versions/:versionId/rollback`, `GET /v1/workflows/:id`.

- [ ] **Step 1: Client methods + type (test first)**

In `apps/web/test/api.test.ts`, add to the matrix: `await client.getDiff('wf1', 'draft', 'v1'); await client.rollbackVersion('wf1', 'v1');` and to `seen`:

```ts
      'GET /v1/workflows/wf1/diff?from=draft&to=v1',
      'POST /v1/workflows/wf1/versions/v1/rollback',
```

Run: `pnpm --filter @xperiment/web test -- api.test.ts` → FAIL. Then in `apps/web/src/lib/api.ts`:

```ts
export interface WorkflowDiff {
  nodes: { added: string[]; removed: string[]; modified: { nodeId: string; changedFields: string[] }[] };
  edges: { added: string[]; removed: string[]; modified: { edgeId: string }[] };
  changed: boolean;
}
```
```ts
  getDiff(id: string, from: string, to: string): Promise<{ from: string; to: string; diff: WorkflowDiff }> {
    const qs = new URLSearchParams({ from, to }).toString();
    return this.request('GET', `/v1/workflows/${id}/diff?${qs}`);
  }
  rollbackVersion(id: string, versionId: string): Promise<{ id: string; versionNumber: number; rolledBackFrom: number }> {
    return this.request('POST', `/v1/workflows/${id}/versions/${versionId}/rollback`);
  }
```

Run: `pnpm --filter @xperiment/web test -- api.test.ts` → PASS.

- [ ] **Step 2: Build the versions page**

Create `apps/web/src/app/(app)/workflows/[id]/versions/page.tsx` (`'use client'`): a container that `useQuery(['workflow', id], () => getWorkflow(id))`. Render:
- A **version list**: for each `versions[]` (number, published-at via `fmtTime`, short hash `shortId(definitionHash)` if present, an "active" badge when `id === activeVersionId`), a **Rollback** button (confirm → `rollbackVersion(id, version.id)` → invalidate `['workflow', id]`).
- Two selectors `from`/`to` populated with each version (label `v{number}`) plus a `Draft` option (value `'draft'`, shown only when `draft` is non-null), a **Compare** button that runs a `useMutation`/local state calling `getDiff(id, from, to)`.
- A **diff view** rendering `diff.nodes.added` (green), `.removed` (red), `.modified` (amber with `changedFields` chips), then the same for edges; a "No changes" line when `!diff.changed`. Root `data-testid="versions-page"`, diff root `data-testid="diff-result"`.
Use Arus tokens, consistent with the usage/alerts pages; loading/empty/error states like those.

- [ ] **Step 3: Link from the workflows list**

In `apps/web/src/app/(app)/workflows/page.tsx`, add a per-row link to `/workflows/{id}/versions` labeled "History" (a `q-btn q-btn--ghost q-btn--sm` or a table cell link), `data-testid={`wf-history-${shortId(w.id)}`}`.

- [ ] **Step 4: Web build + typecheck + commit**

```bash
pnpm --filter @xperiment/web test && pnpm --filter @xperiment/web typecheck && pnpm --filter @xperiment/web build
git add "apps/web/src/app/(app)/workflows/[id]/versions/page.tsx" apps/web/src/lib/api.ts "apps/web/src/app/(app)/workflows/page.tsx" apps/web/test/api.test.ts
git commit -m "feat: add web version-history + diff page"
```

---

### Task K-4: E2E, docs, full verification, review, merge

**Files:**
- Modify: `e2e/test/acceptance.test.ts`, `README.md`

- [ ] **Step 1: E2E diff + rollback flow**

In `e2e/test/acceptance.test.ts`, add a test: create a workflow; PUT a draft with `ir(true)` and publish (v1); PUT a draft with `ir(false)` and publish (v2); `GET /v1/workflows/:id/diff?from=<v1>&to=<v2>` and assert `diff.nodes.modified` contains node `a`; `GET …/diff?from=draft&to=<v1>` asserts `diff.changed === true`; `POST …/versions/<v1>/rollback` → 201 versionNumber 3; then `GET …/diff?from=<v1>&to=<v3>` asserts `changed === false`. Use the suite's `api()` helper (resolve version ids from `GET /v1/workflows/:id`). Reuse a minimal 2-node IR (`webhook.trigger` → `core.transform`).

- [ ] **Step 2: README**

Add a "## Version diff & rollback (Phase 2K)" section: `GET /v1/workflows/:id/diff?from&to` (version id or `draft`) returns a semantic node/edge diff; `POST /v1/workflows/:id/versions/:versionId/rollback` re-publishes an old version forward (history immutable); web version-history page with compare + rollback.

- [ ] **Step 3: Full workspace verification**

```bash
pnpm run test:cov      # ≥80% all packages
pnpm typecheck
pnpm --filter @xperiment/e2e test
pnpm --filter @xperiment/web e2e
```

Add targeted tests if any new file dips a package under 80% (e.g. the API diff route's `no_draft`/`foreign_version` branches — already covered by K-2 tests).

- [ ] **Step 4: Commit**

```bash
git add e2e/test/acceptance.test.ts README.md
git commit -m "feat: version diff + rollback e2e and docs"
```

- [ ] **Step 5: Adversarial review + merge**

Run the adversarial review (security: tenant scoping on diff + rollback, foreign-version rejection, no cross-workflow leakage via version id; correctness: rollback appends the exact IR + hash, version numbering under concurrency, diff of draft-vs-version, stableStringify correctness; typescript: the resolve() union + WorkflowDiff drift; test-gaps: rollback-of-active, diff identical, edge rewire, no-draft branch). Triage confirmed findings, fix CRITICAL/HIGH, re-verify. Then:

```bash
git checkout master && git merge --ff-only feature/phase2-version-diff && git branch -d feature/phase2-version-diff
```

---

## Self-Review

**Spec coverage:** WFL-005 diff → K-1 `diffWorkflows` + K-2 `GET …/diff` + K-3 web diff view. WFL-005 history → existing `GET /v1/workflows/:id` versions, surfaced in K-3. WFL-006 rollback → K-2 `POST …/rollback` via `createVersion`. Draft↔version compare → K-2 `resolve('draft')`.

**Placeholder scan:** No TBD/TODO; every code step shows real code. One "read `getWorkflow` first" verification note (the draft field shape) with a concrete adaptation instruction, not an open placeholder.

**Type consistency:** `WorkflowDiff`/`NodeModification`/`EdgeModification` defined in K-1 (ir) and mirrored in K-3 (web). `diffWorkflows`, `getVersion` (now with `definitionHash`), `createVersion` signatures consistent across K-1/K-2. The diff route returns `{ from, to, diff }` — matched by the K-2 tests and the K-3 web client type.
