# Phase 1 Sub-project D: Canvas UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution — the user's standing choice). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js canvas UI (apps/web, port 3005) where a human registers, builds a workflow visually, wires credentials, publishes, activates, and watches executions — Playwright-verified end to end.

**Architecture:** Two small server-side additions (a `GET /v1/connectors` metadata endpoint and an IR `metadata.layout` passthrough), then a standalone Next.js 14 App Router app that consumes the existing REST API through a typed client. Pure logic (API client, IR⇄canvas mapping, JSON-Schema→form derivation) lives in `src/lib` under Vitest with 80% thresholds; user flows are covered by Playwright against the real five-service stack.

**Tech Stack:** Next.js 14 + React 18, reactflow v11, @tanstack/react-query v5, zustand v4, @fontsource (Plus Jakarta Sans / IBM Plex Mono — self-hosted, no build-time network), zod-to-json-schema (zod v3 side), Vitest, @playwright/test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-phase1-canvas-ui-design.md`; UIUX source `C:\Users\Huawei\Downloads\UIUXDesign.md` §9–12.
- Conventional commits, no attribution trailer. No console.log in production code. No hardcoded secrets.
- Vitest coverage thresholds 80% (lines/statements/functions/branches) scoped to `src/lib/**` in apps/web; all existing package suites must stay green.
- Arus tokens exactly: ink `#171A1F`, lontar `#F6F1E7`, arus lime `#B9F24B` (live/active signals ONLY), tide `#355CFF`, coral `#D9485F`, jade `#0D6B57`; light surfaces `#FFFDF8` / `#FFFFFF` / `#F8F6F0`. Status = icon + label + color, never color alone. 10px node radius, 3px category rails, 4/8px spacing grid, borders over shadows.
- API base `NEXT_PUBLIC_API_URL` default `http://localhost:3000`; web dev port 3005; Playwright services on 3100–3104 (existing e2e convention).
- Anti-template policy: no UI kit; hand-built components on CSS custom properties.

## File Structure

```
packages/ir/src/schema.ts               modify: metadata.layout
packages/connectors/src/catalog.ts      create: connectorCatalog() → JSON-Schema items
apps/api/src/routes/connectors.ts       create: GET /v1/connectors
apps/web/                               create: full app (structure per Task 2)
```

---

### Task P1D-1: Server-side additions (IR layout + /v1/connectors)

**Files:**
- Modify: `packages/ir/src/schema.ts` (metadata.layout), `packages/ir/src/types.ts` (WorkflowIR metadata type)
- Create: `packages/connectors/src/catalog.ts`, export from `packages/connectors/src/index.ts`
- Create: `apps/api/src/routes/connectors.ts`, register in `apps/api/src/server.ts`
- Test: `packages/ir/test/schema.test.ts` (extend), `packages/connectors/test/catalog.test.ts`, `apps/api/test/connectors.test.ts`

**Interfaces:**
- Produces: `metadata.layout?: Record<string, {x: number; y: number}>` accepted by `workflowIrSchema` (strict elsewhere unchanged).
- Produces: `connectorCatalog(registry: ConnectorRegistry): ConnectorCatalogItem[]` where `ConnectorCatalogItem = { type: string; kind: NodeKind; operationVersion: string; defaultEffectClass: EffectClass; outputPorts: string[]; requiresConnection?: string; paramsJsonSchema: unknown }` (zodToJsonSchema with `{ target: 'jsonSchema7', $refStrategy: 'none' }`).
- Produces: `GET /v1/connectors` → `{ items: ConnectorCatalogItem[] }`, viewer-accessible (no roleGate).

- [ ] Failing tests: layout accepted + rejected when malformed (`{x:'a'}` fails); catalog returns 10 items, webhook.trigger item has `properties.authMode.enum`, http.request has no `requiresConnection`, telegram.sendMessage has `requiresConnection: 'telegram'`; API test (authed inject) asserts 200, 10 items, and that no item contains key `run`/`paramsSchema`.
- [ ] Implement: schema/type change; catalog module (`import { zodToJsonSchema } from 'zod-to-json-schema'`); route file mirroring existing route style; add dep `zod-to-json-schema@^3.23.0` to @xperiment/connectors.
- [ ] `pnpm --filter @xperiment/ir --filter @xperiment/connectors --filter @xperiment/api test` green; typecheck green.
- [ ] Commit `feat: add connector catalog endpoint and IR layout metadata`.

### Task P1D-2: apps/web scaffold, Arus tokens, typed API client

**Files:**
- Create: `apps/web/package.json` (`@xperiment/web`, scripts: `dev: next dev -p 3005`, `build`, `start: next start -p 3005`, `test: vitest run`, `test:cov`, `typecheck: tsc --noEmit`, `e2e: playwright test`), `next.config.mjs`, `tsconfig.json`, `vitest.config.ts` (coverage include `src/lib/**`, thresholds 80), `.gitignore` (.next)
- Create: `src/styles/tokens.css`, `src/styles/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx` (redirect `/workflows`), `src/app/providers.tsx` (QueryClientProvider)
- Create: `src/lib/auth.ts` (token store on `localStorage['xperiment.token']`, SSR-safe guards), `src/lib/api.ts`
- Test: `test/api.test.ts`, `test/auth.test.ts` (vitest, stubbed `fetch`/`localStorage`)

**Interfaces (produced, used by every later task):**
```ts
// lib/api.ts
export class ApiError extends Error { constructor(public status: number, public title: string, public detail?: string) }
export interface ClientDeps { baseUrl: string; getToken: () => string | null; onUnauthorized?: () => void }
export class ApiClient {
  constructor(deps: ClientDeps)
  // core: attaches Bearer; content-type only when body !== undefined; 204 → undefined;
  // !ok → parse problem json {title, detail}, 401 also fires onUnauthorized; throws ApiError
  request<T>(method: string, path: string, opts?: { body?: unknown; headers?: Record<string, string> }): Promise<T>
  register(email, password): Promise<{ token: string }>
  login(email, password): Promise<{ token: string }>
  me(): Promise<{ user: {id}; currentWorkspaceId: string; workspaces: {id; name; role}[] }>
  logout(): Promise<void>
  listConnectors(): Promise<{ items: ConnectorItem[] }>
  listWorkflows(): Promise<{ items: WorkflowSummary[]; nextCursor: string | null }>
  createWorkflow(name): Promise<WorkflowSummary>
  getWorkflow(id): Promise<WorkflowDetail>            // includes draft {definition, revision}, versions
  putDraft(id, definition, revision: number): Promise<{ revision: number }>  // If-Match header
  validate(id): Promise<{ valid: boolean; findings: Finding[] }>
  publish(id): Promise<{ id; versionNumber; definitionHash }>
  activate(id): Promise<{ active: true; triggers: TriggerView[] }>
  deactivate(id): Promise<{ active: false }>
  listTriggers(id): Promise<{ triggers: TriggerView[] }>
  execute(id): Promise<{ executionId: string }>
  listConnections(): Promise<{ items: ConnectionRow[] }>
  createConnection(connectorKey, name, payload): Promise<ConnectionRow>
  deleteConnection(id): Promise<void>
  testConnection(id): Promise<{ ok: boolean; error?: string }>
  listExecutions(q?: { workflowId?; limit? }): Promise<{ items: ExecutionSummary[]; nextCursor }>
  getExecution(id): Promise<ExecutionDetail>
}
export function createBrowserClient(): ApiClient // reads NEXT_PUBLIC_API_URL, wires auth.ts + redirect('/login')
// lib/auth.ts
export function getToken(): string | null; export function setToken(t: string): void; export function clearToken(): void
```
- `tokens.css` defines `--color-ink/--color-lontar/--color-arus/--color-tide/--color-coral/--color-jade`, surfaces, semantic aliases (`--status-succeeded: var(--color-jade)` etc.), type scale, `--radius-node: 10px`, `--space-1..8` (4px grid), category rail vars (`--rail-trigger: var(--color-tide)`, `--rail-action: #7C4DDB`, `--rail-logic: #B8860B`), fonts via `@fontsource/plus-jakarta-sans` (400/500/600/700) + `@fontsource/ibm-plex-mono` (400/500) imported in layout.
- ApiError paths tested: 412 conflict, 401 → onUnauthorized fired, network body-less POST has no content-type header, If-Match propagation asserted via captured fetch args.

- [ ] Failing vitest for api/auth → implement → green with coverage ≥80% on `src/lib/**`.
- [ ] `pnpm --filter @xperiment/web typecheck` green; root `pnpm typecheck` still green.
- [ ] Commit `feat: scaffold apps/web with Arus tokens and typed API client`.

### Task P1D-3: Pure logic — IR⇄canvas mapping, schema forms, status meta

**Files:**
- Create: `src/lib/irCanvas.ts`, `src/lib/schemaForm.ts`, `src/lib/statusMeta.ts`
- Test: `test/irCanvas.test.ts`, `test/schemaForm.test.ts`, `test/statusMeta.test.ts`

**Interfaces:**
```ts
// irCanvas.ts — definition may be {} (fresh draft) or a full IR
export interface EditorNode { id: string; type: 'xperiment'; position: {x,y}; data: { ir: IRNodeShape } }
export interface EditorEdge { id: string; source; sourceHandle: string; target; targetHandle: 'main' }
export function definitionToCanvas(definition: unknown): { nodes: EditorNode[]; edges: EditorEdge[] }
export function canvasToDefinition(args: { workflowId: string; name: string; nodes: EditorNode[]; edges: EditorEdge[] }): Record<string, unknown>
// entrypoints = trigger-kind node ids; metadata.layout from positions; edge ids `e_{src}_{handle}_{tgt}`
export function nextNodeId(existing: string[], base: string): string  // http_request, http_request_2, ...
export function makeNode(item: ConnectorItem, id: string, position, defaults: Record<string, unknown>): EditorNode
// schemaForm.ts
export interface FormField { name; label; kind: 'text'|'textarea'|'number'|'boolean'|'select'|'json'; required: boolean; options?: string[]; description?: string }
export function deriveFields(paramsJsonSchema: unknown): FormField[]
export function defaultParams(paramsJsonSchema: unknown): Record<string, unknown> // enum→first, boolean→false, required string→'', number→undefined omitted
export function fieldValueToParam(field: FormField, raw: string | boolean): unknown // number coercion, json parse (throws SyntaxError surfaced by form), ''→omit for optional
// statusMeta.ts
export function statusMeta(status: string): { label: string; glyph: string; colorVar: string; pulse?: boolean }
// SUCCEEDED ✓ jade, FAILED ✕ coral, RUNNING ● tide pulse, QUEUED/CREATED ◌ muted, TIMED_OUT ⏱ coral, SKIPPED ○ muted, RETRY_SCHEDULED ↻ amber, published/draft/Active chips reuse
```
- Round-trip test: full IR (webhook trigger + transform + IF with true/false edges + layout) → canvas → definition equals original canonical fields; `{}` → empty canvas; canvasToDefinition of empty canvas returns `{}` sentinel (avoid failing min-1 schema on save of empty draft — save button disabled anyway, mapping stays total).
- schemaForm tests against REAL catalog JSON Schemas captured as fixtures (record→json field for transform assignments, enum→select for IF operator/webhook authMode, telegram optional baseUrl → optional text).

- [ ] TDD cycle; coverage ≥80% branches on all three modules.
- [ ] Commit `feat: add canvas mapping, schema-driven form, and status metadata libs`.

### Task P1D-4: Auth screens + app shell + workflows list

**Files:**
- Create: `src/app/login/page.tsx`, `src/app/register/page.tsx`, `src/app/(app)/layout.tsx` (auth guard: no token → replace /login; shell), `src/app/(app)/workflows/page.tsx`
- Create: `src/components/shell/Sidebar.tsx`, `src/components/shell/WorkspaceSwitcher.tsx`, `src/components/ui/Button.tsx`, `src/components/ui/TextField.tsx`, `src/components/ui/StatusChip.tsx`, `src/components/ui/EmptyState.tsx`, `src/components/ui/Dialog.tsx`

**Behavior:**
- Login/register: centered card on lontar surface, wordmark "Xperiment" + tagline, email+password, inline problem-detail errors, link between the two; success → setToken → `/workflows`. `data-testid`: `auth-email`, `auth-password`, `auth-submit`, `auth-error`.
- Shell: left sidebar (ink surface, nav Workflows/Executions/Connections with active state = arus 3px left rail + weight), top bar with WorkspaceSwitcher (from `me()`, sets `X-Xperiment-Workspace` via client default header + query invalidation) and logout.
- Workflows list: table rows (name mono-adjacent id, StatusChip draft/published, Active chip in arus lime when `active`), Create dialog (name → createWorkflow → navigate to editor), EmptyState with CTA. `data-testid`: `wf-create`, `wf-name-input`, `wf-create-submit`, `wf-row-{name}`.
- All server data via TanStack Query (`['me']`, `['workflows']`).

- [ ] Manual smoke via `next dev` against running api (no new vitest — flows covered in P1D-8).
- [ ] Commit `feat: add auth screens, app shell, and workflows list`.

### Task P1D-5: Canvas editor

**Files:**
- Create: `src/app/(app)/workflows/[id]/page.tsx` (dynamic import of editor, ssr:false), `src/components/editor/Editor.tsx` (loads workflow+catalog+connections, owns editor state), `src/components/editor/Canvas.tsx` (ReactFlow wrapper), `src/components/editor/XperimentNode.tsx`, `src/components/editor/NodeLibrary.tsx`, `src/components/editor/Inspector.tsx`, `src/components/forms/SchemaForm.tsx`, `src/stores/editorStore.ts` (zustand: selectedNodeId, libraryOpen, dirty)

**Behavior:**
- Editor initializes nodes/edges via `definitionToCanvas(draft.definition)`; auto-layout fallback for missing layout: column drop x=120+idx*320, y=160.
- XperimentNode per spec §5: 264px card, `--radius-node`, 3px kind rail, glyph (per-type emoji-free SVG-ish unicode: trigger ⚡/⏰/▷, http ⇄, transform ƒ, if ⑂, postgres ▤, telegram ✈, openai/gemini ✦), title (node id, renamable in inspector), sub-label `type · vN` IBM Plex Mono 11px, readiness badge: `Needs connection` (requiresConnection && !connectionRef, coral), `Needs config` (any required field empty, amber), `Ready` (jade). Source handles per outputPorts (IF: labeled true/false), one target handle except triggers.
- NodeLibrary: left drawer, search input filtering type/kind, grouped Triggers/Logic/Actions, click-to-add → `makeNode` with `defaultParams` at viewport center offset, id via `nextNodeId`. Adding a second trigger allowed visually but flagged by validation. `data-testid`: `lib-open`, `lib-search`, `lib-item-{type}`.
- Inspector: right panel for selected node — id rename (regex-checked `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, uniqueness enforced, edges remapped), SchemaForm fields (text/textarea get `{{ }}` mono hint styling; json kind = mono textarea with parse-error inline), connection select when requiresConnection (options from `['connections']` filtered by key + "Create connection →" link to /connections), delete node button (removes edges). `data-testid`: `inspector`, `field-{name}`, `node-connection-select`, `node-delete`.
- Edge deletion via selection + Delete key (React Flow default `deleteKeyCode`).

- [ ] Manual smoke: build lead-check graph by hand against dev stack; `pnpm --filter @xperiment/web typecheck` green.
- [ ] Commit `feat: add React Flow canvas editor with schema-driven inspector`.

### Task P1D-6: Editor actions — save, validate, publish, activate

**Files:**
- Create: `src/components/editor/ActionBar.tsx`, `src/components/editor/FindingsPanel.tsx`, `src/components/editor/TriggerPanel.tsx`
- Modify: `src/components/editor/Editor.tsx` (wire mutations), `XperimentNode.tsx` (finding badge overlay)

**Behavior:**
- ActionBar right-aligned over canvas: `Save draft` (disabled when !dirty; putDraft with tracked revision; 412 → non-dismissable banner "Draft changed elsewhere — Reload" reloading query), `Validate` (renders FindingsPanel + per-node coral badge dot with count; green toast when valid), `Publish` (on 422 shows findings; success updates versions + toast `v{n} published`), `Activate`/`Deactivate` toggle (activate success opens TriggerPanel). Statuses surface as chips: draft revision, published version, Active (arus).
- TriggerPanel: for each webhook trigger — production + test URLs with copy buttons, secret shown with shown-once banner (fetched from activate response; listTriggers refetch also returns it per current API) and `authMode`; schedule triggers show cron + timezone + nextFireAt. `data-testid`: `action-save`, `action-validate`, `action-publish`, `action-activate`, `trigger-url`, `trigger-test-url`, `findings-panel`.
- Save serializes via `canvasToDefinition`; dirty tracked on any nodes/edges/params change.

- [ ] Manual smoke: full draft→publish→activate cycle against dev stack.
- [ ] Commit `feat: add editor action bar with validate, publish, and activation panels`.

### Task P1D-7: Connections and executions screens

**Files:**
- Create: `src/app/(app)/connections/page.tsx`, `src/components/connections/ConnectionDialog.tsx`
- Create: `src/app/(app)/executions/page.tsx`, `src/app/(app)/executions/[id]/page.tsx`, `src/components/executions/Timeline.tsx`

**Behavior:**
- Connections: table (name, connectorKey chip, created), Create dialog: connector select (catalog items with requiresConnection, deduped by key) → SchemaForm from `CONNECTION_PAYLOAD_SCHEMAS`-derived JSON Schema — reuse catalog item of the requiring connector? No: payload schemas differ from node params. Add payload schemas to the catalog response? NOT in spec — instead hardcode minimal client-side payload field maps per connector key in `src/lib/connectionFields.ts` (postgres: host/port/database/user/password/ssl?/baseUrl none; telegram: botToken/baseUrl?; openai: apiKey/baseUrl?; gemini: apiKey/baseUrl?) with password-kind fields rendered as `type=password`, never echoed after save. Test button per row → ok chip (jade ✓) / fail chip (coral ✕ + error). Delete with confirm; 409 in-use surfaced. `data-testid`: `conn-create`, `conn-connector-select`, `conn-field-{name}`, `conn-submit`, `conn-test-{name}`, `conn-status-{name}`.
- Executions list: filter by status client-side + workflow query param; rows (id mono 8-char, workflow, StatusChip, started, duration). Detail: header chips, Timeline of `detail.nodes` grouped by nodeId with per-attempt rows (attempt n, status glyph+label, duration, error message when failed), event log section (mono, `detail.events`), polling every 2s while status ∉ {SUCCEEDED, FAILED, TIMED_OUT} via TanStack `refetchInterval`. `data-testid`: `exec-row-{idPrefix}`, `exec-status`, `timeline-node-{nodeId}`.

- [ ] Manual smoke; typecheck green.
- [ ] Commit `feat: add connections and executions screens`.

### Task P1D-8: Playwright e2e + verification + docs

**Files:**
- Create: `apps/web/playwright.config.ts` (chromium only, baseURL http://localhost:3005, webServer `pnpm dev` with env NEXT_PUBLIC_API_URL=http://localhost:3100, globalSetup/teardown), `apps/web/e2e/setup.ts` (spawn api/orchestrator/worker/gateway/scheduler on 3100–3104 — port-kill + spawn + health-wait logic adapted from `e2e/test/helpers.ts`, same SERVICE_ENV incl. e2e secret keys; run `pnpm migrate` first), `apps/web/e2e/stubs.ts` (telegram stub http server on 3311 answering `/botX/getMe`→200 ok:true and sendMessage), `apps/web/e2e/web.spec.ts`
- Modify: `README.md` (Web UI section: dev, e2e, screenshots note), root `package.json` if needed (`web: pnpm --filter @xperiment/web dev`)

**Spec flows (serial, one worker, unique email `web-{run}@xperiment.test`):**
1. register → empty workflows list visible
2. create workflow → library add `webhook.trigger` (authMode none) + `core.transform` → connect edge → save → validate green → publish → activate → `trigger-url` visible
3. `request.post` the trigger URL (JSON body) → executions list gains row → detail timeline shows both nodes SUCCEEDED (poll-wait ≤30s)
4. connections: create telegram connection (botToken `stub-token`, baseUrl `http://localhost:3311`) → test → jade ok chip; reload page → password field empty, token never in DOM (`page.content()` assertion)
5. isolation: register second user → workflows list empty
- Screenshots to `apps/web/e2e/artifacts/` at each flow end (viewports 1280 + 1440 for flow 2).

- [ ] `pnpm exec playwright install chromium`; suite green locally.
- [ ] Full verification: root `pnpm run test:cov` exit 0 (all packages ≥80%), `pnpm typecheck` exit 0, existing `pnpm --filter @xperiment/e2e test` still green, `pnpm --filter @xperiment/web e2e` green.
- [ ] Commit `feat: add Playwright e2e for canvas UI critical path` then `docs: document web UI in README`.

## Self-Review Notes

- Connection payload fields are client-declared (`connectionFields.ts`) rather than server-driven — deviation from "no hardcoded per-connector UI" is scoped to connections only (node params stay schema-driven); recorded as accepted Phase 1 shortcut in spec §9 spirit.
- Activate response is the only place the webhook secret appears; TriggerPanel treats it as shown-once.
- `canvasToDefinition` returning `{}` for an empty canvas keeps saves total; server accepts any draft JSON (validation is a separate step), so no schema failure on save.
