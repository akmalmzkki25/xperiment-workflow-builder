# Phase 1 Sub-project E: AI Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution — the user's standing choice). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Natural-language → validated draft workflow IR (generate + edit) via OpenRouter, applied to the canvas through an AI dock; nothing auto-published.

**Architecture:** A new `@xperiment/ai` package (OpenRouter OpenAI-compatible client + prompt building + JSON extraction + a generate→validate→repair loop reusing `@xperiment/ir`'s `validateWorkflow`). Two builder-gated API routes (`/v1/ai/generate`, `/v1/ai/edit`) resolve workspace connectors + connections for validation context. A web AI dock in the editor applies returned IR to the canvas.

**Tech Stack:** tsx-run TS, zod, vitest (80% thresholds), Fastify, Next.js/React (existing web app).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-phase1-ai-builder-design.md`.
- Conventional commits, no attribution trailer. No console.log in production code. No hardcoded secrets. Immutable updates.
- Provider: OpenRouter, OpenAI-compatible `POST {base}/api/v1/chat/completions`, `Authorization: Bearer <OPENROUTER_API_KEY>`, recommended `HTTP-Referer` + `X-Title` headers. Defaults: `OPENROUTER_MODEL=google/gemini-3.1-flash-lite`, `OPENROUTER_BASE_URL=https://openrouter.ai`.
- The OpenRouter key/model/base come from env only; absent key → routes 503 `ai_unconfigured`. The key must never appear in IR, logs, or any response body.
- `validateWorkflow` (`@xperiment/ir`) is the single validation source of truth — the AI path and manual publish path share it.
- Repair loop hard cap: 3 total attempts.
- Coverage ≥80% (lines/statements/functions/branches) on new `@xperiment/ai` and existing packages; all suites stay green; `pnpm typecheck` clean; both e2e suites green.

## File Structure

```
packages/ai/                          create: new package
  src/index.ts                        barrel
  src/errors.ts                       AiProviderError, AiUnconfiguredError
  src/openrouter.ts                   OpenRouterClient (injectable fetch/model/base)
  src/extract.ts                      extractJson()
  src/prompts.ts                      buildSystemPrompt(catalog), buildUserMessages(...)
  src/generate.ts                     generateWorkflow() repair loop
  test/*.test.ts
apps/api/src/routes/ai.ts             create: /v1/ai/generate + /v1/ai/edit
apps/api/src/server.ts                modify: resolve aiConfig, register ai routes
apps/api/src/routes/deps.ts           modify: ResolvedServerDeps.ai
apps/api/test/ai.test.ts              create: stub OpenRouter server
apps/web/src/components/editor/AiDock.tsx   create
apps/web/src/components/editor/ActionBar.tsx modify: AI dock toggle
apps/web/src/components/editor/Editor.tsx    modify: apply AI IR to canvas
apps/web/src/lib/api.ts               modify: aiGenerate/aiEdit client methods
apps/web/e2e/*                        modify: stub OpenRouter in the stack + dock flow
.env.example, README.md               modify: document OPENROUTER_* + AI builder
```

---

### Task P1E-1: `@xperiment/ai` package — OpenRouter client + JSON extraction

**Files:**
- Create: `packages/ai/package.json` (`@xperiment/ai`, deps `@xperiment/ir` workspace, zod; devDeps vitest/coverage/tsc/@types/node), `tsconfig.json` (mirror `packages/connectors/tsconfig.json`), `vitest.config.ts` (coverage thresholds 80, exclude `src/index.ts`)
- Create: `packages/ai/src/errors.ts`, `src/openrouter.ts`, `src/extract.ts`, `src/index.ts`
- Test: `packages/ai/test/openrouter.test.ts`, `packages/ai/test/extract.test.ts`

**Interfaces (produced):**
```ts
// errors.ts
export class AiProviderError extends Error { constructor(public readonly status: number | null, message: string) }
export class AiUnconfiguredError extends Error {}
// openrouter.ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface OpenRouterConfig {
  apiKey: string; model: string; baseUrl: string;   // baseUrl e.g. https://openrouter.ai
  appUrl?: string; appTitle?: string;
  fetchImpl?: typeof fetch;
}
export interface ChatClient { chat(messages: ChatMessage[], opts?: { responseSchema?: unknown }): Promise<string> }
export function createOpenRouterClient(cfg: OpenRouterConfig): ChatClient
// posts to `${baseUrl}/api/v1/chat/completions`; headers authorization Bearer + content-type
//   + HTTP-Referer(appUrl) + X-Title(appTitle); body { model, messages, response_format? }
//   response_format only when opts.responseSchema given: {type:'json_schema',json_schema:{name:'workflow',strict:true,schema}}
// non-2xx → AiProviderError(status, `openrouter returned ${status}`) — NEVER include key or body text
// returns choices[0].message.content; missing → AiProviderError(null,'no completion returned')
// extract.ts
export function extractJson(text: string): unknown  // strips ```json fences / prose, returns first balanced {...}; throws SyntaxError if none parses
```

- [ ] **Failing tests** — openrouter: given a fake fetch, asserts URL `${base}/api/v1/chat/completions`, `authorization: Bearer sk-x`, `x-title`/`http-referer` present, body has model+messages, and `response_format.json_schema.strict===true` only when a schema is passed; 429 → `AiProviderError` with status 429 and message NOT containing the key; missing choices → throws. extract: fenced ```json block, naked object, object with prose around it, array-wrapped rejected/handled, malformed → throws SyntaxError.
- [ ] **Run** `pnpm --filter @xperiment/ai test` → FAIL (modules absent).
- [ ] **Implement** errors/openrouter/extract/index; add package to workspace (already globbed by `packages/*`). `pnpm install` to link.
- [ ] **Run** tests → PASS; coverage ≥80%.
- [ ] **Commit** `feat: add @xperiment/ai OpenRouter client and JSON extraction`.

### Task P1E-2: Prompt building + generate→validate→repair loop

**Files:**
- Create: `packages/ai/src/prompts.ts`, `src/generate.ts`; export from `src/index.ts`
- Test: `packages/ai/test/prompts.test.ts`, `packages/ai/test/generate.test.ts`

**Interfaces (produced):**
```ts
// prompts.ts — CatalogEntry mirrors ConnectorCatalogItem (type,kind,operationVersion,outputPorts,requiresConnection?,paramsJsonSchema)
export interface CatalogEntry { type: string; kind: string; operationVersion: string; outputPorts: string[]; requiresConnection?: string; paramsJsonSchema: unknown }
export interface ConnectionSummary { id: string; connectorKey: string; name: string }
export function buildSystemPrompt(catalog: CatalogEntry[], connections: ConnectionSummary[]): string
// embeds IR contract (schemaVersion '0.1', workflow{id,name}, entrypoints=trigger ids, nodes[], edges from/to{nodeId,port}, {{ }} expression roots trigger/nodes/execution, connectionRef=one of the given connection ids) + the catalog + connection list; instructs "return ONLY a JSON workflow object".
export function buildUserMessages(prompt: string, currentIr?: unknown): ChatMessage[]
export function repairMessage(findings: unknown): ChatMessage  // user role, "Validation failed: <json>. Return corrected full workflow JSON only."
// generate.ts
export interface GenerateDeps { client: ChatClient; registry: RegistryLike; catalog: CatalogEntry[]; connections: ConnectionSummary[]; maxAttempts?: number }
export interface GenerateResult { ir?: WorkflowIR; findings: ValidationFinding[]; attempts: number }
export async function generateWorkflow(prompt: string, deps: GenerateDeps, currentIr?: unknown): Promise<GenerateResult>
// loop per spec §4: chat → extractJson (parse fail => synthetic finding + repair) → validateWorkflow({registry, connections}) → valid ? return : append assistant+repairMessage; cap maxAttempts (default 3); on give-up return {findings:last, attempts}
```

- [ ] **Failing tests** — prompts: system prompt contains every catalog `type` and each connection id+connectorKey and the string `"schemaVersion"`; user messages include the raw prompt and (edit) the stringified current IR; repairMessage carries the findings JSON. generate (scripted fake ChatClient returning queued strings): (a) first response valid → `{ir, attempts:1, findings:[]}`; (b) invalid-then-valid → `attempts:2`, ir defined; (c) always-invalid → `attempts:3`, `ir` undefined, findings non-empty; (d) non-JSON response → repaired on next attempt; uses a real `createDefaultRegistry()` + a fixture catalog from `connectorCatalog`.
- [ ] **Run** → FAIL → **Implement** → PASS; coverage ≥80% branches.
- [ ] **Commit** `feat: add AI prompt building and validate-repair generation loop`.

### Task P1E-3: API routes `/v1/ai/generate` + `/v1/ai/edit`

**Files:**
- Modify: `apps/api/src/routes/deps.ts` (add `ai: { apiKey: string | null; model: string; baseUrl: string; appUrl?: string }`)
- Modify: `apps/api/src/server.ts` (resolve `ai` from env: `OPENROUTER_API_KEY` (nullable), `OPENROUTER_MODEL` default `google/gemini-3.1-flash-lite`, `OPENROUTER_BASE_URL` default `https://openrouter.ai`, `OPENROUTER_APP_URL`; register ai routes; allow `clientFactory` override in ServerDeps for tests)
- Create: `apps/api/src/routes/ai.ts`
- Test: `apps/api/test/ai.test.ts`

**Interfaces (consumed/produced):**
```ts
// server.ts ServerDeps gains: aiClientFactory?: (cfg) => ChatClient  (default createOpenRouterClient)
// ai.ts
POST /v1/ai/generate  builder role; body { prompt: string(min1) }
POST /v1/ai/edit       builder role; body { prompt: string(min1), definition: unknown }
// both: if ai.apiKey null → sendProblem 503 'ai_unconfigured'
//       build catalog via connectorCatalog(registry); connections via listConnections(pool, workspaceId) → {id,connectorKey,name}
//       generateWorkflow(...) → valid ? 200 {ir, attempts} : sendProblem 422 'ai_generation_failed' with findings, attempts
```

- [ ] **Failing tests** (stub OpenRouter http server, baseUrl override via env or ServerDeps; `aiClientFactory` may wrap `createOpenRouterClient` pointed at the stub): generate with a stub returning a valid lead-check IR → 200, body.ir.nodes present; edit with a supplied definition + stub revising it → 200; unset key → 503 `ai_unconfigured`; stub returns invalid-then-valid → 200 attempts≥2; **secret-hygiene**: set a recognizable fake key, assert it appears in NO response body across the above.
- [ ] **Run** → FAIL → **Implement** → PASS. `pnpm --filter @xperiment/api test` green.
- [ ] **Commit** `feat: add /v1/ai/generate and /v1/ai/edit routes`.

### Task P1E-4: Web AI dock

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add `aiGenerate(prompt): Promise<{ir:unknown;attempts:number}>`, `aiEdit(prompt, definition): Promise<...>`; map 422 findings + 503 into ApiError as today)
- Create: `apps/web/src/components/editor/AiDock.tsx`
- Modify: `apps/web/src/components/editor/ActionBar.tsx` (toggle button `data-testid="ai-open"`) OR host the dock in `Editor.tsx`
- Modify: `apps/web/src/components/editor/Editor.tsx` (pass an `applyDefinition(ir)` callback that runs `definitionToCanvas`, replaces nodes/edges, marks dirty, selects nothing)
- Modify: `apps/web/src/styles/editor.css` (dock styling, Arus)

**Interfaces:**
```tsx
// AiDock props: { open; onClose; mode-less; currentDefinition: () => Record<string,unknown>; onApply: (ir: unknown) => void }
// textarea (data-testid="ai-prompt"), Generate (data-testid="ai-generate") -> aiGenerate,
//   Edit current (data-testid="ai-edit") -> aiEdit(prompt, currentDefinition()); busy state; error/findings surface (data-testid="ai-error")
// Editor.applyDefinition: setNodes/setEdges from definitionToCanvas(ir), markDirty, select(null), close dock
```

- [ ] Build the dock + wiring. No new vitest (logic already covered; flow covered by Playwright in P1E-5). `pnpm --filter @xperiment/web typecheck` green.
- [ ] Manual smoke against a locally-stubbed generate is optional (covered in P1E-5).
- [ ] **Commit** `feat: add AI dock to the workflow editor`.

### Task P1E-5: Playwright flow + verification + docs + merge

**Files:**
- Modify: `apps/web/e2e/services.ts` (add an OpenRouter stub http server on a fixed port returning a canned valid workflow JSON in OpenAI chat-completions shape; export its port; set `OPENROUTER_API_KEY`/`OPENROUTER_BASE_URL`/`OPENROUTER_MODEL` in SERVICE_ENV so the API's ai config points at the stub)
- Modify: `apps/web/e2e/web.spec.ts` (new test: create workflow → open AI dock → type prompt → Generate → canvas gains the stubbed nodes → Validate green)
- Modify: `.env.example` (`OPENROUTER_API_KEY=`, `OPENROUTER_MODEL=google/gemini-3.1-flash-lite`, `OPENROUTER_BASE_URL=https://openrouter.ai`), `README.md` (AI Builder section)

- [ ] Add the OpenRouter stub to the e2e stack; write the dock Playwright flow.
- [ ] **Run** `pnpm --filter @xperiment/web e2e` → green.
- [ ] **Full verification:** `pnpm run test:cov` exit 0 (all ≥80%), `pnpm typecheck` exit 0, `pnpm --filter @xperiment/e2e test` green, grep: no `OPENROUTER_API_KEY` literal value or key echo in `apps/**/src`.
- [ ] **Commit** `feat: add AI builder e2e flow` then `docs: document AI builder in README`.
- [ ] Adversarial review (dimensions: security incl. prompt-injection + key-leak, correctness of the repair loop + canvas apply, TS, test gaps); fix confirmed findings; re-verify.
- [ ] Fast-forward merge `feature/phase1-ai` → master; delete branch.

## Self-Review Notes

- Key never crosses into the browser: the web client calls our API, which holds `OPENROUTER_API_KEY` server-side — the dock only sends a prompt.
- The AI cannot bypass validation: `generateWorkflow` returns an IR only when `validateWorkflow` passes, the same gate publish uses.
- Determinism in tests: every layer injects the client/fetch or stubs the HTTP server; no live OpenRouter calls anywhere.
- 503-vs-422 split keeps "not configured" distinct from "model couldn't comply," so the dock can message each correctly.
