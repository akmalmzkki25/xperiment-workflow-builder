# Phase 2 Sub-project L — WhatsApp Vertical Pack — Design

**Status:** Approved (design gate 2026-07-25). Final Phase 2 slice.
**Requirements:** PRD TMP-001 (browse templates by use case/app/industry), TMP-002 (preview workflow + required credentials), TMP-003 (clone template to workspace), TMP-004 (template versioning); Indonesian WhatsApp vertical pack (lines 43/133/284: ≥3 curated WhatsApp business-automation templates); CON-009 (WhatsApp Cloud API connector — shipped in G).
**Out of scope (later / not needed):** user-published templates, marketplace, ratings/install-count, revenue sharing (TMP-005..010, C/W priority); AI template retrieval (TMP-008); template upgrade-in-place.

## Goal

Ship a curated, browsable WhatsApp vertical pack: builders can browse the templates, preview each workflow and its required credentials, and clone one into their workspace as a new draft they then connect and publish.

## Architecture

**Built-in in-code catalog + read-only browse/preview + clone-to-draft.** Templates are curated product content, so they live as a static in-code catalog (mirroring the connector catalog), each a validated Workflow IR plus metadata. Browse/preview is read-only. Clone creates a new workflow in the caller's workspace whose draft equals the template IR (`createWorkflow` + `updateDraft`), with credentialed nodes' `connectionRef` unset; the user attaches the WhatsApp connection, reviews on the canvas, and publishes — the existing publish-gating enforces `connection_required`. No migration, no new persistence.

Rejected: a DB-seeded templates table (needed only for user-published templates, which are out of scope) and clone-with-auto-publish (would publish before the user attaches credentials and would fail gating).

## Components

### apps/api/src/templates/catalog.ts

```ts
export interface WorkflowTemplate {
  id: string;                 // stable slug, e.g. 'wa-lead-auto-reply'
  name: string;
  description: string;
  category: 'sales' | 'cs' | 'ops';
  useCase: string;            // one-line "when to use"
  version: string;            // '1.0.0' — immutable per template (TMP-004)
  requiredConnectors: string[]; // connector keys the template needs, e.g. ['whatsapp']
  definition: WorkflowIR;     // valid IR; credentialed nodes have connectionRef unset
}
export function listTemplates(category?: string): WorkflowTemplate[];
export function getTemplate(id: string): WorkflowTemplate | undefined;
```

**The pack (3 templates), each valid IR over existing connectors** (`webhook.trigger {authMode:'none'}`, `core.transform {fields}`, `core.if {condition}` ports `true`/`false`, `whatsapp.sendMessage {to, text}` `requiresConnection:'whatsapp'`, connectionRef omitted):

1. **`wa-lead-auto-reply`** (sales) — `webhook.trigger` → `core.transform` (extract `name`/`phone`) → `whatsapp.sendMessage` (greeting reply to `{{ … .phone }}`).
2. **`wa-order-receipt`** (cs) — `webhook.trigger` (order placed) → `core.transform` (format receipt text) → `whatsapp.sendMessage` (send receipt). (PRD line 284)
3. **`wa-appointment-reminder`** (ops) — `webhook.trigger` → `core.if` (condition on appointment window) → `true` → `whatsapp.sendMessage` (reminder); `false` → end.

`requiredConnectors` for all three is `['whatsapp']`.

### apps/api/src/routes/templates.ts

Registered in `server.ts`; tenant/auth applies; rate-limited.

- `GET /v1/templates?category=` — `{ items: TemplateSummary[] }` where `TemplateSummary = { id, name, description, category, useCase, version, requiredConnectors }` (no `definition`). Optional `category` filter (zod-validated enum; invalid → 400 or ignored).
- `GET /v1/templates/:id` — the full template incl. `definition` (the IR preview, TMP-002); 404 if unknown.
- `POST /v1/templates/:id/clone` (builder) — body `{ name? }`. 404 if unknown. `createWorkflow(pool, { workspaceId, name: name ?? template.name })` then `updateDraft(pool, { workflowId, definition: template.definition, expectedRevision: 1 })`; respond 201 `{ id, name }` (the new workflow).
- OpenAPI paths added.

### apps/web

- **`/templates` gallery page:** category-grouped cards (name, description, useCase, `requiredConnectors` chips). Selecting a card shows a preview (node-type list + required credentials) and a **Use this template** button → `cloneTemplate(id)` → `router.push('/workflows/{newId}')` (opens the editor on the cloned draft). Arus design, consistent with the connections/usage pages.
- **`lib/api.ts`:** `listTemplates(category?)`, `getTemplate(id)`, `cloneTemplate(id, name?)` + `TemplateSummary`/`WorkflowTemplate` types.
- Nav: add a "Templates" link.

## Data flow

```
GET /v1/templates[?category] → listTemplates() → summaries (no IR)
GET /v1/templates/:id → getTemplate(id) → full template (IR preview + requiredConnectors)
POST /v1/templates/:id/clone → createWorkflow + updateDraft(template IR) → new workflow (draft)
  → user attaches whatsapp connection → publish (gating enforces connection_required) → run
```

## Error handling

- Clone builder-gated; new workflow lands in `authOf(req).workspaceId`; unknown template → 404.
- The catalog is validated by tests: each `definition` passes `validateWorkflow` (registry) and `requiredConnectors` equals the set of `requiresConnection` keys across its nodes — the pack can never ship malformed or with wrong "required credentials".
- `category` filter zod-validated; unknown category returns an empty list (or 400), never a 500.
- Cloned drafts intentionally lack connections; publishing before attaching one returns the existing `connection_required` 422 from publish — expected, documented.

## Testing

- **catalog (`apps/api/test/templates.test.ts`), pure checks:** for every template — `validateWorkflow(t.definition, { registry })` is valid; `requiredConnectors` deep-equals the sorted unique set of `requiresConnection` for its node types; ids are unique; ≥3 templates; each has a `webhook.trigger` entrypoint and a `whatsapp.sendMessage` node.
- **api:** `GET /v1/templates` returns ≥3 summaries without `definition`; `?category=sales` filters; `GET /:id` returns the IR; unknown id → 404; `POST /:id/clone` creates a workflow whose `getDraft` deep-equals the template IR, named per the body or the template; the clone lands in the caller's workspace (a second workspace can't see it); builder-gate.
- **web:** `listTemplates`/`getTemplate`/`cloneTemplate` client matrix; gallery data mapping.
- **e2e:** `POST /v1/templates/wa-lead-auto-reply/clone` → create a `whatsapp` connection (stub baseUrl) → attach it to the whatsapp node (PUT draft with connectionRef) → publish (200) → fire the webhook → assert `whatsapp.sendMessage` posts to the stub. This proves the shipped template IR is valid, publishable once connected, and runnable end-to-end.

Gates before merge: all package suites green, coverage ≥80% every package, root `typecheck` clean, `@xperiment/e2e` + `@xperiment/web e2e` green, then adversarial multi-agent review, fix confirmed findings, fast-forward merge `feature/phase2-whatsapp-pack` → master.

## File layout

```
apps/api/src/templates/catalog.ts        (new: the pack + listTemplates/getTemplate)
apps/api/src/routes/templates.ts         (new: GET list/detail + POST clone)
apps/api/src/server.ts                    (register)
apps/api/src/openapi.ts                   (paths)
apps/api/test/templates.test.ts          (new: catalog validity + routes)
apps/web/src/app/(app)/templates/page.tsx (new: gallery + preview + clone)
apps/web/src/lib/api.ts                    (client + types)
apps/web/src/components/shell/Sidebar.tsx  (Templates nav)
apps/web/test/api.test.ts                  (matrix)
e2e/test/acceptance.test.ts                (clone → connect → publish → run)
README.md                                  (Templates / WhatsApp pack section)
```
