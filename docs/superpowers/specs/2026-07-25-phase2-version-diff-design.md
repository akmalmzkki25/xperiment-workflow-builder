# Phase 2 Sub-project K — Version Diff & Rollback — Design

**Status:** Approved (design gate 2026-07-25)
**Requirements:** PRD WFL-005 (version history and diff), WFL-006 (rollback creates a new published version from an old one), "menampilkan diff" (show diff).
**Out of scope (later / not needed):** per-parameter deep path diff (nodes report a single `parameters` field-change), 3-way/merge, diff of layout/positions (deliberately ignored).

## Goal

Let a builder see the version history of a workflow, compare any two versions (or a draft against a version) as a readable semantic diff, and roll a workflow back by re-publishing an old version's IR as a new immutable version.

## Architecture

**A pure IR diff + a thin read-only API + a web history/diff panel; rollback reuses the existing publish path.** The diff is a deterministic pure function in `@xperiment/ir` (`diffWorkflows`) so the API and web render identical results and it is trivially unit-testable. Version history already exists (`workflow_versions`, immutable, returned by `GET /v1/workflows/:id`). Rollback (WFL-006) loads the target version and calls the existing `createVersion(pool, { workflowId, definition, hash })`, which appends a new version and sets it active — history is never mutated.

## Components

### packages/ir

- **`diff.ts`:**
  ```ts
  export interface NodeModification { nodeId: string; changedFields: string[] }
  export interface EdgeModification { edgeId: string }
  export interface WorkflowDiff {
    nodes: { added: string[]; removed: string[]; modified: NodeModification[] };
    edges: { added: string[]; removed: string[]; modified: EdgeModification[] };
    changed: boolean;
  }
  export function diffWorkflows(from: WorkflowIR, to: WorkflowIR): WorkflowDiff
  ```
  - Nodes keyed by `id`. `added` = ids in `to` not in `from`; `removed` = ids in `from` not in `to`. For a shared id, compare the fields `kind`, `type`, `operationVersion`, `connectionRef`, and `parameters` (deep structural equality via a stable-stringify/`JSON.stringify` of a normalized value); `changedFields` lists whichever differ (`parameters` reported as one field). Only ids whose `changedFields` is non-empty appear in `modified`.
  - Edges keyed by `id`. `added`/`removed` by id; a shared id whose `from`/`to` endpoints differ goes to `modified`.
  - `changed = added|removed|modified non-empty on nodes or edges`.
  - Pure and layout-agnostic (never inspects `metadata.layout`). No throw on well-formed IR.
- Export `diffWorkflows` + the diff types from `packages/ir/src/index.ts`.

### packages/db

- **`getVersion`** (extend): also return `definitionHash` (select `definition_hash`) so rollback reuses the stored hash without re-parsing. New shape: `{ id, workflowId, versionNumber, definition, definitionHash }`.

### apps/api

- **`routes/workflows.ts`** (extend; both routes tenant-scoped via `getWorkflow(pool, id, workspaceId)` and rate-limited):
  - `GET /v1/workflows/:id/diff?from=&to=` — `from`/`to` each a version UUID or the literal `draft`. Loads the workflow (404 if absent). For each ref: `draft` → the workflow's current draft definition (400 `no_draft` if none); otherwise `getVersion(ref)` and assert `version.workflowId === id` (400 `foreign_version` / 404 unknown). Parse both with `workflowIrSchema`, run `diffWorkflows`, return `{ from, to, diff }` where `from`/`to` echo the resolved labels (version number or `"draft"`). Read-only, no role gate beyond auth (viewer+).
  - `POST /v1/workflows/:id/versions/:versionId/rollback` (builder) — `getWorkflow` (404), `getVersion(versionId)` and assert it belongs to `id` (404 otherwise), then `createVersion(pool, { workflowId: id, definition: version.definition, hash: version.definitionHash })`; respond 201 `{ id, versionNumber, rolledBackFrom: version.versionNumber }`.
  - Register the two paths in `OPENAPI_DOCUMENT`.

### apps/web

- **Workflow detail page** (`app/(app)/workflows/[id]/page.tsx` or an extracted `VersionHistory` component): a version-history panel listing versions (number, published-at, short hash, active badge), two `from`/`to` selectors (each a version or "Draft"), a **Compare** button that calls `getDiff` and renders the diff — nodes then edges, grouped as Added (green) / Removed (red) / Modified (amber, with the changed-field chips), and a "No changes" state when `changed` is false — and a per-version **Rollback** button (confirm → `rollbackVersion` → invalidate the workflow query).
- **`lib/api.ts`:** `getDiff(id, from, to)` and `rollbackVersion(id, versionId)` + the `WorkflowDiff` type (mirrors the ir shape).

## Data flow

```
GET /v1/workflows/:id/diff?from&to
  → resolve from/to (version def or draft def) → workflowIrSchema.parse → diffWorkflows → { from, to, diff }
POST /v1/workflows/:id/versions/:versionId/rollback
  → getVersion(target) → createVersion(workflowId, target.definition, target.definitionHash) → new active version
```

## Error handling

- Diff: `from`/`to` required (400 if missing); a version ref not belonging to the workflow → 400 `foreign_version`; unknown version → 404; `draft` ref with no draft → 400 `no_draft`. Malformed stored IR would fail `workflowIrSchema.parse` (500) — not expected since only validated IR is ever published/saved.
- Rollback: version not in this workflow → 404; append-only, so it can never corrupt history; concurrent rollbacks each just append a version (the `FOR UPDATE` in `createVersion` serializes version numbering).
- Diff is pure and side-effect-free; identical IRs return `changed: false` with empty arrays.

## Testing

- **ir (`test/diff.test.ts`):** node added / removed / modified (type change; parameters-only change → `changedFields:['parameters']`; connectionRef change); edge added / removed / rewired (endpoint change → modified); identical IRs → `changed:false`, all arrays empty; multiple simultaneous changes.
- **api:** diff version↔version (returns the expected added/removed/modified); diff draft↔version; `foreign_version` 400 (a version id from another workflow); `no_draft` 400; rollback creates a new active version whose definition deep-equals the target and whose versionNumber is max+1; rollback of a foreign version → 404; cross-workspace diff/rollback → 404.
- **web:** api-client `getDiff`/`rollbackVersion` in the method matrix; diff-panel data mapping (a small pure mapper if extracted).
- **e2e:** publish v1 → save a draft edit → `GET /diff?from=draft&to=<v1>` shows the changed node → publish v2 → `POST rollback` to v1 → the workflow's new active version's IR deep-equals v1's.

Gates before merge: all package suites green, coverage ≥80% (statements/branches/functions/lines) every package, root `typecheck` clean, `@xperiment/e2e` + `@xperiment/web e2e` green, then adversarial multi-agent review, fix confirmed findings, fast-forward merge `feature/phase2-version-diff` → master.

## File layout

```
packages/ir/src/diff.ts                              (new)
packages/ir/src/index.ts                             (export diffWorkflows + types)
packages/ir/test/diff.test.ts                        (new)
packages/db/src/repos/workflows.ts                   (getVersion returns definitionHash)
apps/api/src/routes/workflows.ts                     (diff + rollback routes)
apps/api/src/openapi.ts                              (paths)
apps/api/test/versionDiff.test.ts                    (new)
apps/web/src/app/(app)/workflows/[id]/...            (version/diff panel + rollback)
apps/web/src/lib/api.ts                              (getDiff, rollbackVersion, WorkflowDiff type)
apps/web/test/api.test.ts                            (matrix)
e2e/test/acceptance.test.ts                          (diff + rollback flow)
README.md                                            (Version diff section)
```
