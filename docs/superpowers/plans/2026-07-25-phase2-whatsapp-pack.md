# WhatsApp Vertical Pack (Phase 2 Sub-project L) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a curated WhatsApp vertical pack: builders browse the templates, preview each workflow + its required credentials, and clone one into their workspace as a new draft.

**Architecture:** A static in-code template catalog (each a validated WorkflowIR + metadata). Read-only browse/preview routes + a clone route that creates a new workflow whose draft = the template IR (reusing `createWorkflow` + `updateDraft`). A web Templates gallery.

**Tech Stack:** pnpm monorepo, TS ESM via tsx, Vitest (v8 coverage ≥80%), Fastify, Next.js (Arus).

## Global Constraints

- No `console.log`; no hardcoded secrets. TDD: failing test first. Coverage ≥80% every metric per package.
- Conventional commits `<type>: <description>`, NO attribution trailer. Focused files.
- Templates are built-in/immutable; clone creates a new workflow **draft** (credentialed nodes have `connectionRef` unset). Publish-gating already enforces `connection_required`.
- Valid IR facts (from `examples/lead-check.json`): expressions are `{{ trigger.body.<field> }}`; edges use `from.port` = `'main'` (or `'true'`/`'false'` for `core.if`) and `to.port` = `'input'`; every node has `operationVersion: '0.1.0'`.
- Node types + params: `webhook.trigger` (kind `trigger`, `{ authMode:'none' }`, port `main`); `core.transform` (kind `logic`, `{ fields: Record }`, port `main`); `core.if` (kind `logic`, `{ condition }`, ports `true`/`false`); `whatsapp.sendMessage` (kind `action`, `{ to, text }`, `requiresConnection:'whatsapp'`, port `main`).
- Reuse: `createWorkflow(pool,{workspaceId,name})`, `updateDraft(pool,{workflowId,definition,expectedRevision})`, `validateWorkflow` + `createDefaultRegistry`, `connectorCatalog`/registry for `requiresConnection`.
- Branch `feature/phase2-whatsapp-pack` is checked out; the spec is committed. Docker Postgres/Redis running.

---

### Task L-1: Template catalog + validity test

**Files:**
- Create: `apps/api/src/templates/catalog.ts`
- Test: `apps/api/test/templates.test.ts` (catalog-validity portion)

**Interfaces:**
- Produces:
  - `interface WorkflowTemplate { id: string; name: string; description: string; category: 'sales'|'cs'|'ops'; useCase: string; version: string; requiredConnectors: string[]; definition: WorkflowIR }`
  - `listTemplates(category?: string): WorkflowTemplate[]`
  - `getTemplate(id: string): WorkflowTemplate | undefined`

- [ ] **Step 1: Write the failing validity test**

Create `apps/api/test/templates.test.ts`:

```ts
import { connectorCatalog, createDefaultRegistry } from '@xperiment/connectors';
import { validateWorkflow } from '@xperiment/ir';
import { describe, expect, test } from 'vitest';
import { getTemplate, listTemplates } from '../src/templates/catalog.js';

const registry = createDefaultRegistry();
const requiresByType = new Map(
  (connectorCatalog(registry) as { type: string; requiresConnection?: string }[]).map((c) => [c.type, c.requiresConnection]),
);

describe('template catalog', () => {
  test('ships at least three templates with unique ids', () => {
    const all = listTemplates();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });

  test('every template is valid IR with a webhook trigger and a whatsapp node', () => {
    for (const t of listTemplates()) {
      const result = validateWorkflow(t.definition, { registry });
      expect(result.valid, `${t.id}: ${JSON.stringify(result.findings)}`).toBe(true);
      const types = t.definition.nodes.map((n) => n.type);
      expect(types).toContain('webhook.trigger');
      expect(types).toContain('whatsapp.sendMessage');
    }
  });

  test('requiredConnectors equals the set of requiresConnection across nodes', () => {
    for (const t of listTemplates()) {
      const needed = [...new Set(t.definition.nodes.map((n) => requiresByType.get(n.type)).filter(Boolean))].sort();
      expect(t.requiredConnectors.slice().sort()).toEqual(needed);
    }
  });

  test('listTemplates filters by category and getTemplate resolves by id', () => {
    const sales = listTemplates('sales');
    expect(sales.every((t) => t.category === 'sales')).toBe(true);
    expect(getTemplate('wa-lead-auto-reply')?.category).toBe('sales');
    expect(getTemplate('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/api test -- templates.test.ts`
Expected: FAIL — `../src/templates/catalog.js` not found.

- [ ] **Step 3: Implement the catalog**

Create `apps/api/src/templates/catalog.ts`:

```ts
import type { WorkflowIR } from '@xperiment/ir';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: 'sales' | 'cs' | 'ops';
  useCase: string;
  version: string;
  requiredConnectors: string[];
  definition: WorkflowIR;
}

const trigger = { id: 't', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'none' } } as const;

const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'wa-lead-auto-reply',
    name: 'WhatsApp lead auto-reply',
    description: 'Instantly reply to a new lead on WhatsApp with a friendly greeting.',
    category: 'sales',
    useCase: 'A web form or WhatsApp lead arrives; send an automatic first response.',
    version: '1.0.0',
    requiredConnectors: ['whatsapp'],
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wa_lead', name: 'WhatsApp lead auto-reply' },
      entrypoints: ['t'],
      nodes: [
        { ...trigger },
        { id: 'extract', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { name: '{{ trigger.body.name }}', phone: '{{ trigger.body.phone }}' } } },
        { id: 'reply', kind: 'action', type: 'whatsapp.sendMessage', operationVersion: '0.1.0', parameters: { to: '{{ trigger.body.phone }}', text: 'Halo {{ trigger.body.name }}, terima kasih telah menghubungi kami! Tim kami akan segera membalas.' } },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'extract', port: 'input' } },
        { id: 'e2', from: { nodeId: 'extract', port: 'main' }, to: { nodeId: 'reply', port: 'input' } },
      ],
    },
  },
  {
    id: 'wa-order-receipt',
    name: 'WhatsApp order receipt',
    description: 'Send a WhatsApp receipt when an order is placed.',
    category: 'cs',
    useCase: 'An order webhook fires; confirm it to the customer on WhatsApp.',
    version: '1.0.0',
    requiredConnectors: ['whatsapp'],
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wa_receipt', name: 'WhatsApp order receipt' },
      entrypoints: ['t'],
      nodes: [
        { ...trigger },
        { id: 'format', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { orderId: '{{ trigger.body.orderId }}', total: '{{ trigger.body.total }}' } } },
        { id: 'send', kind: 'action', type: 'whatsapp.sendMessage', operationVersion: '0.1.0', parameters: { to: '{{ trigger.body.phone }}', text: 'Terima kasih! Pesanan #{{ trigger.body.orderId }} sebesar Rp {{ trigger.body.total }} telah kami terima.' } },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'format', port: 'input' } },
        { id: 'e2', from: { nodeId: 'format', port: 'main' }, to: { nodeId: 'send', port: 'input' } },
      ],
    },
  },
  {
    id: 'wa-appointment-reminder',
    name: 'WhatsApp appointment reminder',
    description: 'Remind a customer on WhatsApp when their appointment is near.',
    category: 'ops',
    useCase: 'A scheduler/webhook checks upcoming appointments; remind those within 24h.',
    version: '1.0.0',
    requiredConnectors: ['whatsapp'],
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wa_reminder', name: 'WhatsApp appointment reminder' },
      entrypoints: ['t'],
      nodes: [
        { ...trigger },
        { id: 'check', kind: 'logic', type: 'core.if', operationVersion: '0.1.0', parameters: { condition: '{{ trigger.body.hoursUntil <= 24 }}' } },
        { id: 'remind', kind: 'action', type: 'whatsapp.sendMessage', operationVersion: '0.1.0', parameters: { to: '{{ trigger.body.phone }}', text: 'Pengingat: Anda memiliki janji temu pada {{ trigger.body.appointmentTime }}. Sampai jumpa!' } },
        { id: 'skip', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { skipped: true } } },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'check', port: 'input' } },
        { id: 'e2', from: { nodeId: 'check', port: 'true' }, to: { nodeId: 'remind', port: 'input' } },
        { id: 'e3', from: { nodeId: 'check', port: 'false' }, to: { nodeId: 'skip', port: 'input' } },
      ],
    },
  },
];

export function listTemplates(category?: string): WorkflowTemplate[] {
  return category ? TEMPLATES.filter((t) => t.category === category) : TEMPLATES;
}

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @xperiment/api test -- templates.test.ts`
Expected: PASS. If `validateWorkflow` rejects a template, fix the offending param/expression/`operationVersion` (the connector's declared `operationVersion` may differ — read `packages/connectors/src/whatsapp/sendMessage.ts` etc. and match it) until valid. Do NOT weaken the test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/templates/catalog.ts apps/api/test/templates.test.ts
git commit -m "feat: add WhatsApp vertical pack template catalog"
```

---

### Task L-2: API — list / detail / clone routes

**Files:**
- Create: `apps/api/src/routes/templates.ts`
- Modify: `apps/api/src/server.ts` (register), `apps/api/src/openapi.ts` (paths)
- Test: `apps/api/test/templates.test.ts` (extend with route tests)

**Interfaces:**
- Consumes: `listTemplates`, `getTemplate` (catalog); `createWorkflow`, `updateDraft` (@xperiment/db); `authOf`, `roleGate`; `sendProblem`.
- Produces: `GET /v1/templates?category`, `GET /v1/templates/:id`, `POST /v1/templates/:id/clone`.

- [ ] **Step 1: Write the failing route tests**

Add to `apps/api/test/templates.test.ts` (a new `describe` needing a server + authed user — mirror the imports/harness of `apps/api/test/versionDiff.test.ts`: `createPool`, `runMigrations`, `buildServer`, `createAuthedUser`):

```ts
// (add at top-level of the file, alongside the catalog describe)
import { createPool, getDraft, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;
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

describe('/v1/templates routes', () => {
  test('lists summaries without the IR and filters by category', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/templates' });
    expect(r.statusCode).toBe(200);
    const items = r.json<{ items: { id: string; definition?: unknown }[] }>().items;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]!.definition).toBeUndefined();
    const sales = await auth.inject({ method: 'GET', url: '/v1/templates?category=sales' });
    expect(sales.json<{ items: { category: string }[] }>().items.every((t) => t.category === 'sales')).toBe(true);
  });

  test('detail returns the IR; unknown id is 404', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/templates/wa-lead-auto-reply' });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ definition: { nodes: unknown[] } }>().definition.nodes.length).toBeGreaterThan(0);
    expect((await auth.inject({ method: 'GET', url: '/v1/templates/nope' })).statusCode).toBe(404);
  });

  test('clone creates a workflow whose draft equals the template IR', async () => {
    const r = await auth.inject({ method: 'POST', url: '/v1/templates/wa-lead-auto-reply/clone', payload: { name: 'My WA flow' } });
    expect(r.statusCode).toBe(201);
    const id = r.json<{ id: string; name: string }>().id;
    expect(r.json<{ name: string }>().name).toBe('My WA flow');
    const draft = await getDraft(pool, id);
    expect(draft?.definition).toEqual(getTemplate('wa-lead-auto-reply')!.definition);
    // lands in the caller's workspace only
    const other = await createAuthedUser(app);
    expect((await other.inject({ method: 'GET', url: `/v1/workflows/${id}` })).statusCode).toBe(404);
  });

  test('cloning an unknown template is 404', async () => {
    expect((await auth.inject({ method: 'POST', url: '/v1/templates/nope/clone' })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @xperiment/api test -- templates.test.ts`
Expected: FAIL — routes not registered (404 on list).

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/templates.ts`:

```ts
import { createWorkflow, updateDraft } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, roleGate } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import { getTemplate, listTemplates, type WorkflowTemplate } from '../templates/catalog.js';
import type { ResolvedServerDeps } from './deps.js';

function summarize(t: WorkflowTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    useCase: t.useCase,
    version: t.version,
    requiredConnectors: t.requiredConnectors,
  };
}
const cloneSchema = z.object({ name: z.string().min(1).max(120).optional() }).strict();

export function registerTemplateRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/templates', async (req) => {
    const category = (req.query as { category?: string }).category;
    return { items: listTemplates(typeof category === 'string' ? category : undefined).map(summarize) };
  });

  app.get('/v1/templates/:id', async (req, reply) => {
    const t = getTemplate((req.params as { id: string }).id);
    if (!t) return sendProblem(reply, 404, 'Template not found');
    return t;
  });

  app.post('/v1/templates/:id/clone', async (req, reply) => {
    const ctx = authOf(req);
    if (!roleGate(reply, ctx, 'builder')) return;
    const t = getTemplate((req.params as { id: string }).id);
    if (!t) return sendProblem(reply, 404, 'Template not found');
    const parsed = cloneSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid body', parsed.error.message);
    const wf = await createWorkflow(deps.pool, { workspaceId: ctx.workspaceId, name: parsed.data.name ?? t.name });
    await updateDraft(deps.pool, { workflowId: wf.id, definition: t.definition, expectedRevision: 1 });
    return reply.status(201).send({ id: wf.id, name: wf.name });
  });
}
```

Register in `apps/api/src/server.ts` (import `registerTemplateRoutes`, call alongside the other route groups). Add OpenAPI paths:

```ts
    '/v1/templates': { get: { summary: 'Browse workflow templates (optional ?category)', tags: ['templates'] } },
    '/v1/templates/{id}': { get: { summary: 'Template detail incl. IR preview + required credentials', tags: ['templates'] } },
    '/v1/templates/{id}/clone': { post: { summary: 'Clone a template into a new workflow draft', tags: ['templates'] } },
```

> Note: `createWorkflow` returns a `WorkflowRow` with `id`/`name`; `updateDraft` bumps the seeded revision 1 → 2. The draft row is created by `createWorkflow` at revision 1, so `expectedRevision: 1` matches. Verify `createWorkflow`'s return has `name` (it does — `RETURNING *` mapped).

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

```bash
pnpm --filter @xperiment/api test -- templates.test.ts && pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/templates.ts apps/api/src/server.ts apps/api/src/openapi.ts apps/api/test/templates.test.ts
git commit -m "feat: add /v1/templates browse + clone routes"
```

---

### Task L-3: Web Templates gallery

**Files:**
- Modify: `apps/web/src/lib/api.ts` (client + types)
- Create: `apps/web/src/app/(app)/templates/page.tsx`
- Modify: `apps/web/src/components/shell/Sidebar.tsx` (nav)
- Test: `apps/web/test/api.test.ts` (matrix)

**Interfaces:**
- Consumes: `GET /v1/templates`, `GET /v1/templates/:id`, `POST /v1/templates/:id/clone`.

- [ ] **Step 1: Client methods + types (test first)**

In `apps/web/test/api.test.ts`, add to the matrix: `await client.listTemplates(); await client.getTemplate('wa-lead-auto-reply'); await client.cloneTemplate('wa-lead-auto-reply');` and to `seen`:

```ts
      'GET /v1/templates',
      'GET /v1/templates/wa-lead-auto-reply',
      'POST /v1/templates/wa-lead-auto-reply/clone',
```

Run → FAIL, then in `apps/web/src/lib/api.ts`:

```ts
export interface TemplateSummary {
  id: string; name: string; description: string; category: string; useCase: string; version: string; requiredConnectors: string[];
}
export interface WorkflowTemplate extends TemplateSummary {
  definition: { nodes: { id: string; type: string }[]; edges: unknown[] };
}
```
```ts
  listTemplates(category?: string): Promise<{ items: TemplateSummary[] }> {
    return this.request('GET', `/v1/templates${category ? `?category=${encodeURIComponent(category)}` : ''}`);
  }
  getTemplate(id: string): Promise<WorkflowTemplate> {
    return this.request('GET', `/v1/templates/${id}`);
  }
  cloneTemplate(id: string, name?: string): Promise<{ id: string; name: string }> {
    return this.request('POST', `/v1/templates/${id}/clone`, name ? { body: { name } } : {});
  }
```

Run → PASS.

- [ ] **Step 2: Build the gallery page**

Create `apps/web/src/app/(app)/templates/page.tsx` (`'use client'`): `useQuery(['templates'], () => getBrowserClient().listTemplates())`. Render category-grouped **cards** (name, description, `useCase`, `requiredConnectors` chips). Each card has a **Use this template** button running a `useMutation(cloneTemplate(id))` whose `onSuccess({id})` calls `router.push('/workflows/'+id)`. Optionally a per-card preview (fetch `getTemplate(id)` on expand, list node types). Root `data-testid="templates-page"`; each card `data-testid={`template-${t.id}`}`; button `data-testid={`use-${t.id}`}`. Arus tokens, loading/empty/error states like the usage/alerts pages.

- [ ] **Step 3: Nav + web build/typecheck/commit**

Add `{ href: '/templates', label: 'Templates' }` to `NAV` in `Sidebar.tsx` (near Workflows).

```bash
pnpm --filter @xperiment/web test && pnpm --filter @xperiment/web typecheck && pnpm --filter @xperiment/web build
git add apps/web/src/lib/api.ts "apps/web/src/app/(app)/templates/page.tsx" apps/web/src/components/shell/Sidebar.tsx apps/web/test/api.test.ts
git commit -m "feat: add web Templates gallery"
```

---

### Task L-4: E2E, docs, full verification, review, merge

**Files:**
- Modify: `e2e/test/acceptance.test.ts`, `README.md`

- [ ] **Step 1: E2E clone → connect → publish → run**

In `e2e/test/acceptance.test.ts`, add a test: `POST /v1/templates/wa-lead-auto-reply/clone` → new workflow id. `GET /v1/workflows/:id` to read the draft + revision. Create a `whatsapp` connection via `createConnection('whatsapp', 'WA', { accessToken:'stub-token', phoneNumberId:'123', baseUrl: providerUrl })`. PUT the draft with the `reply` node's `connectionRef` set to that connection id (clone-then-attach), `if-match` = current revision. `POST publish` → expect < 300. Then fire the webhook trigger for the workflow (activate + POST to the gateway `/t/:routeKey`, as the whatsapp e2e test already does) with a body `{ name, phone }`, wait for terminal SUCCEEDED, and assert `whatsappMessages` received one message. Reuse the whatsapp stub branch already in the provider stub (`/messages`).

> Keep it deterministic: reuse the exact connection-create + activate + webhook-fire pattern from the existing `whatsapp.sendMessage runs against the vault credential` test; only the workflow definition differs (it comes from the clone).

- [ ] **Step 2: README**

Add a "## Templates & WhatsApp vertical pack (Phase 2L)" section: built-in curated templates; `GET /v1/templates` (browse, `?category`), `GET /v1/templates/:id` (preview IR + required credentials), `POST /v1/templates/:id/clone` (new workflow draft — attach the WhatsApp connection then publish). The three shipped templates (lead auto-reply, order receipt, appointment reminder). Web Templates gallery.

- [ ] **Step 3: Full workspace verification**

```bash
pnpm run test:cov      # ≥80% all packages
pnpm typecheck
pnpm --filter @xperiment/e2e test
pnpm --filter @xperiment/web e2e
```

Add targeted tests if any new file dips a package under 80%.

- [ ] **Step 4: Commit**

```bash
git add e2e/test/acceptance.test.ts README.md
git commit -m "feat: WhatsApp pack e2e and docs"
```

- [ ] **Step 5: Adversarial review + merge**

Run the adversarial review (security: clone tenant scoping + builder gate, template ids can't traverse, no injection via category; correctness: cloned draft equals the template IR, revision math for updateDraft, the shipped IRs stay valid/publishable-once-connected; typescript: the summarize omit typing, catalog `as const` shapes, WorkflowTemplate drift web↔api; test-gaps: each template's validity, clone-into-caller-workspace, unknown-template 404, category filter). Triage confirmed findings, fix CRITICAL/HIGH, re-verify. Then:

```bash
git checkout master && git merge --ff-only feature/phase2-whatsapp-pack && git branch -d feature/phase2-whatsapp-pack
```

This completes Sub-project L and all of Phase 2.

---

## Self-Review

**Spec coverage:** TMP-001 browse by use-case → L-2 `GET /v1/templates` (category filter) + L-3 gallery. TMP-002 preview + required credentials → L-2 `GET /:id` (IR + `requiredConnectors`). TMP-003 clone → L-2 `POST /:id/clone`. TMP-004 versioning → each template's immutable `version`. WhatsApp pack (≥3) → L-1 catalog (lead-auto-reply, order-receipt, appointment-reminder). The pack-validity invariant (valid IR + accurate requiredConnectors) is enforced by the L-1 test.

**Placeholder scan:** No TBD/TODO; every code step shows real code. The `operationVersion`/expression-validity risk is handled by the L-1 test driving correctness (fix-until-valid, don't weaken), not left as a placeholder.

**Type consistency:** `WorkflowTemplate` defined in L-1 (catalog) and mirrored (minus/plus `definition`) as `TemplateSummary`/`WorkflowTemplate` in L-3 (web). `listTemplates`/`getTemplate` signatures used unchanged in L-1/L-2. Clone returns `{ id, name }` — matched by the L-2 test and the L-3 client type.
