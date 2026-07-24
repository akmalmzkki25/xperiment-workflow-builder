# Phase 1 Sub-project E: AI Builder — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (Phase 0 + Phase 1 A/B/C/D merged); branch `feature/phase1-ai`
**PRD requirements covered:** AI-001 (natural-language → workflow generation),
AI-002 (natural-language edit of an existing workflow), AI-003 (generated output is
validated before it reaches the user).
**Provider:** OpenRouter (OpenAI-compatible), model `google/gemini-3.1-flash-lite`.
**Deferred:** streaming token output, multi-turn refinement chat history, AI-authored
expressions beyond what the model emits inline, per-node "explain this" or "fix this
node" affordances, cost/usage metering UI, prompt templates library, non-OpenRouter
providers (the client is provider-shaped but only OpenRouter is wired).

---

## 1. Goal

A user describes a workflow in plain language (Indonesian or English) and gets a valid,
editable draft on the canvas — either generated from scratch or as an edit to the
current draft. Generated IR is always validated server-side before it is applied;
nothing is auto-published.

## 2. Architecture

New package `@xperiment/ai` (tsx-run TS, vitest 80% thresholds) holding:
- an **OpenRouter client** (`openrouter.ts`): OpenAI-compatible `POST
  https://openrouter.ai/api/v1/chat/completions` over `fetch`, `Authorization: Bearer`,
  `HTTP-Referer`/`X-Title` app headers, model + baseUrl injectable for tests. Returns the
  assistant message content string; throws a typed `AiProviderError` (never leaks the key).
- **prompt building** (`prompts.ts`): system prompt embeds the connector catalog
  (type, kind, operationVersion, outputPorts, requiresConnection, param JSON Schemas) plus
  the IR contract (schemaVersion, node/edge shape, entrypoints, `{{ }}` expression roots,
  connectionRef rules). User prompt = the request; for edits, also the current IR JSON.
- **JSON extraction** (`extract.ts`): tolerate fenced ```json blocks / prose wrappers →
  first balanced top-level object.
- **generate-with-repair loop** (`generate.ts`): the reliability backbone (§4).

The API gains two builder-gated routes (`apps/api/src/routes/ai.ts`):
- `POST /v1/ai/generate` `{ prompt }` → `{ ir, findings, attempts }` (draft IR, not saved).
- `POST /v1/ai/edit` `{ prompt, definition }` → same shape, seeded with the current draft.
Both resolve the workspace's published connectors + connections for validation context and
return **only** a validated IR or a 422 with the last findings.

The web editor gains an **AI dock** (§5).

## 3. Provider + credentials

- Key from platform env `OPENROUTER_API_KEY` (like `TRIGGER_SECRET_KEY`); resolved in
  `buildServer` deps. Absent key → routes return 503 `ai_unconfigured` (no crash).
- Model/base overridable via `OPENROUTER_MODEL` (default `google/gemini-3.1-flash-lite`)
  and `OPENROUTER_BASE_URL` (default the public endpoint) — the latter lets the e2e/API
  tests point at a local stub.
- `response_format: { type: 'json_schema', json_schema: { name, strict:true, schema } }`
  is sent best-effort (a slim generation schema, not the full strict IR schema). Because
  provider strictness varies, correctness never depends on it — the validate+repair loop
  (§4) is authoritative.

## 4. Generate-with-repair loop (core reliability)

```
attempt 1: messages = [system(catalog+contract), user(request[, currentIR])]
loop (max 3 attempts total):
  content = openrouter.chat(messages)
  candidate = extractJson(content)                     // parse error → repair msg
  result = validateWorkflow(candidate, { registry, connections })   // real 5-layer
  if result.valid: return { ir: result.ir, findings: [], attempts: n }
  append assistant(content) + user("Validation failed: <findings as JSON>. Return
     corrected full workflow JSON only.")               // findings drive the fix
return 422 { findings: lastFindings, attempts: 3 }        // give up cleanly
```

- `validateWorkflow` is reused verbatim — the AI path and the manual publish path share
  one source of truth, so anything the AI emits must pass the same gate as hand-built IR.
- Connection layer (layer 5) runs with the workspace's real connections, so the model is
  told which connections exist and cannot invent credential ids.
- Deterministic + fast in tests: the OpenRouter client is injected; a scripted fake
  returns canned completions per attempt.
- Bounded (3 attempts) and secret-safe (findings and errors never include the key or raw
  provider error bodies).

## 5. Web AI dock

- A collapsible dock in the editor (button in the ActionBar, `data-testid="ai-open"`),
  Arus-styled, mono prompt textarea, "Generate" (blank/replace) and "Edit current"
  buttons, a busy state, and an inline error/finding surface.
- On success, the returned IR replaces the canvas via the existing `definitionToCanvas`
  mapping and marks the draft dirty (user still reviews, saves, validates, publishes) —
  the AI never saves or publishes.
- Edit mode sends the current `canvasToDefinition` output as `definition`.
- Findings from a 422 render in the dock (reusing the finding row style) so the user sees
  why the model couldn't comply.

## 6. Screens / API summary

| Surface | Behavior |
|---|---|
| `POST /v1/ai/generate` | builder role; `{prompt}` → validated draft IR or 422 findings / 503 unconfigured |
| `POST /v1/ai/edit` | builder role; `{prompt, definition}` → validated revised IR |
| AI dock | prompt in, IR onto canvas, dirty; never auto-saves |

## 7. Testing

- **Unit (`@xperiment/ai`, ≥80%):** prompt assembly includes every catalog node type;
  `extractJson` handles fenced/prose/naked JSON and malformed input; the repair loop
  (a) returns on first valid, (b) repairs once then succeeds, (c) gives up after 3 with
  findings — all with a scripted fake client; client builds correct headers/body and
  raises `AiProviderError` on non-2xx without leaking the key.
- **API (`@xperiment/api`):** stub OpenRouter server (baseUrl override) — generate returns a
  valid draft applied to no workflow (pure IR), edit revises a supplied definition,
  unconfigured key → 503, a scripted invalid-then-valid sequence exercises repair, and a
  secret-hygiene assertion that the key never appears in any response body.
- **Playwright (`apps/web/e2e`):** with the stub OpenRouter wired into the e2e stack,
  open the dock → type a prompt → Generate → nodes appear on the canvas → Validate green.
- No live OpenRouter calls in any test.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Model ignores structured-output / emits prose | JSON extraction + validate+repair loop; correctness independent of provider strictness |
| Model invents node types / connection ids | Catalog + real connections embedded in prompt; layer-2/3/5 validation rejects; repair loop feeds the error back |
| Runaway token cost / infinite repair | Hard cap of 3 attempts; flash-lite is low-cost; no streaming |
| Key leakage | Env-var only, never in IR/logs/responses; provider errors sanitized; secret-hygiene test |
| Prompt injection via workflow content on edit | The model only produces IR that must pass validation; output is applied to the canvas, never executed without the user publishing |
