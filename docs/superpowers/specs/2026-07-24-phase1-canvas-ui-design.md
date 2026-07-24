# Phase 1 Sub-project D: Canvas UI — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (A + B + C merged); branch `feature/phase1-web`
**PRD requirements covered:** CAN-001 (core subset: add/connect/delete/duplicate),
CAN-002 (zoom/pan/fit), CAN-005 (node search), CAN-006 (inline validation badges),
CAN-011 (execution path highlighting — timeline level), MON-001/002/003 (list, detail
timeline, masked previews), WFL UI surfaces for validate/publish/activate,
SEC UI: secrets write-only.
**Design source:** `UIUXDesign.md` §9–12 (Arus visual system), §10.6 (status mapping),
§10.7 (category rails), §11 (typography), §18 (node anatomy — simplified).
**Deferred:** minimap, auto-layout, undo/redo, semantic zoom, sub-workflows, pin data,
copy/paste across workflows, dark theme polish (variables shipped, light is primary),
mobile, real-time co-editing, AI dock (sub-project E).

---

## 1. Goal

A non-CLI human can register, build a workflow on a canvas, wire credentials, publish,
activate, and watch executions — through a UI that follows the Arus design language
rather than a default component-library look.

## 2. App shape

- `apps/web`: Next.js 14 App Router, TypeScript strict, port 3005. Not part of the
  vitest `pnpm -r test` chain for UI rendering — logic modules are unit-tested with
  Vitest; user flows are Playwright-tested (see §8).
- Dependencies: `next`, `react`, `react-dom`, `reactflow`, `@tanstack/react-query`,
  `zustand`. No UI kit — hand-built components on CSS custom properties (anti-template
  policy).
- API access: typed client in `apps/web/src/lib/api.ts` (mirrors CLI client, browser
  fetch, bearer from `localStorage['xperiment.token']`; 401 → redirect to /login).
  `NEXT_PUBLIC_API_URL` (default `http://localhost:3000`).

## 3. New API surface (small)

`GET /v1/connectors` (auth: viewer) → `{ items: [{ type, kind, operationVersion,
defaultEffectClass, outputPorts, requiresConnection?, paramsJsonSchema }] }` where
`paramsJsonSchema` = zod schema converted via `zod-to-json-schema` (dep added to
`@xperiment/connectors`). The web node library and config forms are driven entirely by this
endpoint — no hardcoded per-connector UI.

## 4. Screens and routes

| Route | Content |
|---|---|
| `/login`, `/register` | Email/password forms; on success store token, go to `/workflows` |
| `/workflows` | List with UIUX §10.6 status chips (icon + label + color), Create button, workspace switcher in header |
| `/workflows/[id]` | Editor: canvas center, node library drawer left (search + grouped by kind), inspector right, action bar (Save draft · Validate · Publish · Activate/Deactivate) |
| `/connections` | List + create dialog (per-connector schema-driven form) + test button (ok/fail chip) + delete |
| `/executions` | List with status filter; row → `/executions/[id]` |
| `/executions/[id]` | Node timeline (per-attempt rows, status glyphs, durations), event log (mono), error details |

## 5. Canvas (React Flow)

- Custom `XperimentNode`: 264 px card, 10 px radius, 3 px category rail (colors UIUX §10.7),
  header (connector glyph + business title + status badge), sub-label
  `type · operationVersion` in IBM Plex Mono 11 px, readiness badge (Needs connection /
  Needs config / Ready) from client-side validation state.
- Edges: solid default; IF `true`/`false` ports labeled; delete via select+Del.
- Node library → drag or click-to-add appends a node with default params at viewport
  center; connections drawn by dragging handles (React Flow default), edge validity
  checked on drop (single entrypoint rule surfaced as a toast).
- Inspector: form generated from `paramsJsonSchema` — string/number/boolean/enum/record
  fields; strings get an expression hint (`{{ }}`) with a mono textarea for multiline;
  nodes with `requiresConnection` get a connection select filtered by connector key
  (+ inline “create connection” link). Node id + rename supported.
- IR mapping: canvas state ⇄ IR nodes/edges; layout positions stored in the draft
  definition under `metadata.layout` (`Record<nodeId, {x, y}>`) — the IR schema gains
  this optional passthrough field (server change: allow `metadata.layout`).
- Save: PUT draft with If-Match revision (conflict → reload prompt). Validate renders
  findings as node badges + a findings panel. Publish/Activate mirror API semantics;
  activation response shows webhook URLs + secret with copy buttons (shown-once
  banner).

## 6. Design system (Arus)

- Tokens in `apps/web/src/styles/tokens.css` — exact values from UIUXDesign §10.2–10.5
  (brand.ink #171A1F, brand.lontar #F6F1E7, arus #B9F24B, tide #355CFF, coral #D9485F,
  jade #0D6B57; light surfaces #FFFDF8/#FFFFFF/#F8F6F0; semantic table §10.5; dark
  variables included but unpolished).
- Typography: Plus Jakarta Sans (UI) + IBM Plex Mono (ids, expressions, logs) via
  `next/font`; scale from §11.2.
- Status chips always icon + label + color (§4.10 grayscale rule). Arus Lime restricted
  to live/active signals (§10.1): Active chip, running pulse, focus ring.
- Spacing 4/8 px grid; borders over shadows for permanent panels (§12.4).

## 7. State

- TanStack Query for all server data (workflows, draft, connectors, connections,
  executions; execution detail polls every 2 s while non-terminal).
- Zustand only for canvas-local state (selected node, drawer open, dirty flag).
- URL carries state where shareable (execution id, workflow id).

## 8. Testing

- **Vitest (apps/web, thresholds 80% on `src/lib/**`):** IR ⇄ canvas mapping (nodes,
  edges, layout round-trip), JSON-schema → form-field derivation, api client behaviors
  (401 handling, If-Match propagation).
- **Playwright (`apps/web/e2e`, chromium):** against the full stack (5 services + web):
  1. register → land on empty workflows list;
  2. create workflow → add webhook.trigger + core.transform on canvas → connect edge →
     save → validate (green) → publish → activate → webhook URL visible;
  3. fire the webhook via request → executions list shows the run → detail timeline
     shows SUCCEEDED nodes;
  4. connections page: create telegram connection against stub → test → ok chip;
     secrets never rendered after creation;
  5. isolation smoke: second user sees an empty workspace.
  Run via `pnpm --filter @xperiment/web e2e` (Playwright starts `next dev` itself; services
  assumed up like the existing e2e suite).
- No visual-regression suite yet (deferred); Playwright screenshots captured as
  artifacts for manual review.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Canvas/IR drift | Single mapping module with round-trip unit tests |
| Schema-driven forms too generic for good UX | Per-type field ordering/labels overridable in a small registry-side `uiHints` map (future); Phase 1 generic forms acceptable |
| Draft conflicts from two tabs | If-Match already enforced; UI surfaces reload prompt |
| Token in localStorage (XSS surface) | Accepted for alpha; documented; cookie migration with CSRF later |
| Frontend bloat vs budgets | No UI kit, tree-shaken deps, dynamic-import React Flow |
