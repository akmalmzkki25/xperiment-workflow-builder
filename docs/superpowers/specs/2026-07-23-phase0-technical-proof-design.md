# Phase 0 Technical Proof — Design

**Project:** Xperiment Workflow Builder (working name; PRD refers to `[Nama Produk]`)
**Date:** 2026-07-23
**Status:** Approved by user (sections 1–4 approved in brainstorming session)
**Source documents:** `PRD.md` §17 Phase 0, `HighLevelDesign.md` §9–§13, `RisetKompetitor.md`, `UIUXDesign.md` (not exercised in Phase 0)

---

## 1. Goal

Prove the core runtime thesis of the platform: a versioned Workflow IR executed by a
deterministic, observable engine with at-least-once delivery, idempotency, and automatic
retry — before any UI, AI builder, or multi-tenancy exists.

**Exit criteria (from PRD Phase 0):**

1. A workflow JSON runs consistently end-to-end: same workflow version + same input →
   same terminal state, repeatably.
2. Every retry and every state transition is persisted and inspectable via API/CLI.

## 2. Scope

### In scope

- Workflow IR v0 (schema, validation, immutable publish).
- Manual trigger only.
- Three node types: `http.request`, `core.transform`, `core.if`.
- Execution engine: state machines, at-least-once delivery, outbox pattern, automatic
  retry with backoff, worker crash recovery.
- Persistence in PostgreSQL; queues in Redis/BullMQ.
- REST API (Fastify) + thin CLI.
- Structured logging (pino) and append-only execution event trail.
- Single seeded default workspace. `workspace_id` exists on every table for forward
  compatibility, but there is no auth and no tenant isolation enforcement.

### Out of scope (deferred to Phase 1+)

UI/canvas, AI builder, webhook/schedule/polling triggers, credential vault/OAuth,
wait/resume, human approval, cancellation, manual replay/retry endpoints, sub-workflows,
loops/merge nodes, billing/metering, OpenTelemetry, object storage for payloads,
multi-tenant auth/RBAC, connector SDK/registry service.

## 3. Decisions log

| Decision | Choice | Alternatives considered |
|---|---|---|
| Infrastructure | PostgreSQL + Redis/BullMQ via Docker Compose | SQLite zero-dep; Postgres-only |
| Interface | REST API + thin CLI client | CLI-only; API-only |
| Topology | Full service split: `api`, `orchestrator`, `worker` as separate processes | Monorepo w/ 2 processes; single package/process |
| Repo layout | pnpm monorepo (apps + shared packages) | Single package |
| Payload storage | Inline JSONB with size cap; `*_ref` naming keeps object-storage path open | Object storage now |
| Commit attribution | Disabled per user global settings | — |

Relevant HLD ADRs adopted as-is: ADR-001 (own IR), ADR-002 (at-least-once +
idempotency), ADR-003 (draft/published separation), ADR-004 (no arbitrary code),
ADR-005 (Redis/BullMQ first).

## 4. Topology

```text
xperiment-workflow-builder/
├── apps/
│   ├── api/            # Fastify control plane: workflow CRUD, validate, publish, execute, inspect
│   ├── orchestrator/   # Data-plane brain: creates executions, computes graph readiness,
│   │                   #   dispatches node tasks, schedules retries, resolves terminal state
│   ├── worker/         # Task executor: leases node tasks, resolves expressions, runs node,
│   │                   #   classifies errors, emits completion events
│   └── cli/            # Thin client of the API
├── packages/
│   ├── ir/             # IR v0 types + zod schemas (JSON Schema derived) + graph validators
│   ├── expressions/    # {{ }} recursive-descent parser + AST evaluator (no eval/Function)
│   ├── engine-core/    # Pure state-machine transition rules + retry classifier
│   ├── connectors/     # http.request connector (manifest + runtime)
│   ├── db/             # Postgres schema, migrations, repositories
│   └── queue/          # BullMQ queue names + typed payload contracts
└── docker-compose.yml  # postgres:16, redis:7 (+ optional containerized services)
```

Rules:

- Services communicate **only** through Postgres (state, source of truth) and
  Redis/BullMQ (queues). No service-to-service HTTP.
- The API never executes nodes. The worker reads only published immutable versions.
- Each service exposes `GET /v1/healthz` (worker/orchestrator expose a minimal HTTP
  liveness endpoint for this purpose only).
- Dev runs: Postgres + Redis via Docker Compose; the three Node services via
  `tsx watch` locally (containerized service definitions provided but optional).
- Node.js ≥ 20, TypeScript strict mode, pnpm workspaces.

## 5. Workflow IR v0

### 5.1 Shape

```json
{
  "schemaVersion": "0.1",
  "workflow": { "id": "wf_x", "name": "Demo" },
  "entrypoints": ["trigger_1"],
  "nodes": [
    {
      "id": "trigger_1",
      "kind": "trigger",
      "type": "manual.trigger",
      "operationVersion": "0.1.0",
      "parameters": {},
      "settings": { "timeoutMs": 30000, "retry": { "maxAttempts": 1 } }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "from": { "nodeId": "trigger_1", "port": "main" },
      "to": { "nodeId": "check", "port": "input" }
    }
  ]
}
```

- Node kinds in v0: `trigger` | `action` | `logic`.
- Every node has an `effectClass`: `pure` | `read` | `write` (v0 subset of the HLD
  taxonomy). It is defaulted by node type (see §7.4) and may be explicitly overridden
  in the IR; used by the retry classifier now, by replay policy later.
- `settings`: `timeoutMs` (default 30000), `retry` (see §7.3).
- Workflow-level `metadata.executionTimeoutMs` (default 900000 = 15 min) bounds the
  whole execution; see §7.1.

### 5.2 Validation layers (run in order; all findings returned structured)

1. JSON Schema (zod-derived) — shape and types.
2. Graph integrity — unique node IDs, edges reference existing nodes/ports, exactly one
   entrypoint, entrypoint is a trigger, no cycles, all nodes reachable from entrypoint.
3. Node-type parameter schemas — per-connector/per-logic-node zod schemas.
4. Expression parse — every expression in parameters compiles; parse errors carry
   node ID, field path, and character position.

### 5.3 Draft / publish lifecycle

- Draft IR is mutable, stored in `workflow_drafts`, guarded by a revision number
  (optimistic concurrency via `If-Match`).
- `publish` runs all validation layers; on success writes an immutable
  `workflow_versions` row with `version_number` (monotonic) and `definition_hash`
  (SHA-256 of canonicalized IR JSON).
- Executions reference `workflow_version_id`, never the draft.

## 6. Expression language v0

- User syntax: `{{ expression }}` inside string parameter values; a parameter that is
  exactly one expression yields the raw value (any JSON type), otherwise interpolation
  into a string.
- Implementation: hand-written recursive-descent parser → AST → evaluator. No `eval`,
  no `new Function`, no dynamic property access beyond the AST forms below.
- Context roots: `trigger.body`, `nodes.<nodeId>.output`, `execution.id`.
- Supported: property access (dot + `["key"]`), literals (string/number/boolean/null),
  comparison (`== != < <= > >=`), boolean (`&& || !`), null coalescing (`??`),
  parentheses, whitelisted functions: `lower`, `upper`, `trim`, `length`, `toNumber`,
  `toString`.
- Rejected at parse time: `__proto__`, `constructor`, `prototype` as identifiers;
  any function not in the whitelist; assignment; anything else.
- Evaluation errors (missing property yields `null` via safe navigation; type errors
  throw) are non-retryable node failures with position-annotated messages.

## 7. Execution model

### 7.1 State machines

Execution: `CREATED → QUEUED → RUNNING → SUCCEEDED | FAILED | TIMED_OUT`

Node task: `PENDING → READY → QUEUED → RUNNING → SUCCEEDED | RETRY_SCHEDULED → QUEUED | FAILED | SKIPPED`

- All transitions are compare-and-set SQL updates (`UPDATE … WHERE status = expected`);
  an unexpected current status means a duplicate/late message and is dropped (logged).
- Every transition appends to `execution_events` (append-only, `BIGSERIAL` sequence).
- `TIMED_OUT`: the orchestrator enforces the workflow-level execution timeout
  (`metadata.executionTimeoutMs`, default 15 min) via a delayed watchdog job enqueued
  at execution start; if the execution is still non-terminal when it fires, remaining
  nodes are failed with `code: "execution_timeout"` and the execution resolves to
  `TIMED_OUT`. Per-node `timeoutMs` failures are ordinary node failures (retryable per
  policy) and resolve to `FAILED` if attempts are exhausted.

### 7.2 Delivery semantics: at-least-once + idempotent consumers

1. `POST /execute` → one transaction writes `trigger_events` + `executions (CREATED)` +
   `task_outbox` row. A duplicate `Idempotency-Key` for the same workflow returns the
   existing execution (HTTP 200, not 201).
2. Each writing service runs an outbox publisher loop: reads unpublished `task_outbox`
   rows, publishes to BullMQ, marks published. Crash between DB commit and publish →
   the row is republished later; consumers dedupe.
3. Orchestrator consumes `execution.requested`: CAS `CREATED→QUEUED`, marks the
   entrypoint node READY→QUEUED, enqueues a node task (job ID =
   `{executionId}:{nodeId}:{attempt}` for queue-level dedupe).
4. Worker leases the task, builds the expression context from stored node outputs,
   resolves parameters, executes the node with `timeoutMs` + `AbortSignal`, classifies
   the outcome, CAS-writes the `execution_nodes` result, emits `node.completed` via its
   outbox.
5. Orchestrator consumes completions: routes IF output ports, marks unreached branch
   nodes `SKIPPED`, marks newly-ready nodes READY→QUEUED, and when no non-terminal
   nodes remain resolves the execution terminal state (`SUCCEEDED` if all terminal
   nodes succeeded/skipped; `FAILED` if any failed; `TIMED_OUT` if the failure cause
   was execution-level timeout).

### 7.3 Retry

Default policy (per HLD §11.5), overridable per node via `settings.retry`:

```json
{
  "maxAttempts": 3,
  "strategy": "exponential-jitter",
  "initialDelayMs": 1000,
  "maxDelayMs": 60000,
  "retryOn": ["timeout", 408, 425, 429, 500, 502, 503, 504]
}
```

- Retryable failure with attempts remaining → `RETRY_SCHEDULED`, orchestrator enqueues
  a delayed BullMQ job for attempt N+1.
- Each attempt is a distinct `execution_nodes` row
  (`UNIQUE(execution_id, node_id, attempt)`) — full retry history is inspectable.
- Non-retryable: 4xx (except the retryOn list), expression errors, validation errors,
  SSRF blocks.
- Worker crash mid-task: BullMQ stalled-job detection re-delivers; CAS result writes +
  per-attempt job IDs prevent double-commit.

### 7.4 Node behaviors

| Node | Kind | effectClass | Behavior |
|---|---|---|---|
| `manual.trigger` | trigger | pure | Emits the `POST /execute` payload as `trigger.body`. |
| `http.request` | action | write (default; `read` if method is GET/HEAD) | Method, URL, headers, query, JSON body (all expression-capable), `timeoutMs`, `AbortSignal`. Output `{ status, headers, body }`. Non-2xx is a failure classified by the retry table. SSRF guard: loopback/private/link-local IP ranges and non-http(s) schemes blocked by default; env-config allowlist for local testing. DNS resolution is checked before connect. |
| `core.transform` | logic | pure | Builds a **new** object from field→expression mappings. Never mutates input. |
| `core.if` | logic | pure | Evaluates one boolean expression; routes to named output ports `true` / `false`. Unreached branch subtree → `SKIPPED`. |

## 8. Data model (Phase 0 subset of HLD §9)

All tables carry `workspace_id` (FK to the single seeded workspace) and timestamps.

- `workspaces` — one seeded row (`default`).
- `workflows` — id, name, status, `active_version_id`, `draft_revision`.
- `workflow_drafts` — `workflow_id` PK, `definition_json` JSONB, `revision`.
- `workflow_versions` — immutable; `version_number`, `definition_json`,
  `definition_hash`; `UNIQUE(workflow_id, version_number)`.
- `trigger_events` — `idempotency_key`, payload JSONB, status;
  `UNIQUE(workflow_id, idempotency_key)` (Phase 0 has no trigger registry; the
  workflow ID stands in for `trigger_id`).
- `executions` — status, mode (`production` only in Phase 0), `workflow_version_id`,
  `trigger_event_id`, `idempotency_key`, timings, `error_summary`.
- `execution_nodes` — status, `attempt`, `input_json`, `output_json`, `error_json`,
  timings, `worker_id`; `UNIQUE(execution_id, node_id, attempt)`.
- `execution_events` — `sequence BIGSERIAL`, `event_type`, `node_id NULL`,
  `payload_json`.
- `task_outbox` — aggregate type/id, event type, payload, `published_at NULL`,
  attempts.

Payload JSONB values are capped (256 KB per node input/output; larger values are
rejected with a clear error). Column naming keeps the HLD `*_ref` migration path open
for Phase 1 object storage.

Migrations: plain SQL files run by a small migration runner in `packages/db` (tracked
in a `schema_migrations` table).

## 9. API surface (Fastify, `/v1`)

```text
POST   /v1/workflows                  create workflow + empty draft
GET    /v1/workflows                  list (cursor pagination)
GET    /v1/workflows/{id}             metadata + draft + version list
PUT    /v1/workflows/{id}/draft       replace draft IR (If-Match revision check)
POST   /v1/workflows/{id}/validate    run validation layers, return structured findings
POST   /v1/workflows/{id}/publish     validate + freeze immutable version
POST   /v1/workflows/{id}/execute     manual trigger; body = trigger payload; Idempotency-Key honored
GET    /v1/executions?workflowId=     list executions (cursor pagination)
GET    /v1/executions/{id}            execution + node states + attempts + event timeline
GET    /v1/healthz                    liveness (each service)
```

- Errors: RFC 7807 problem details (`type`, `title`, `status`, `detail`, plus
  `errors[]` for validation findings).
- Every request gets/propagates `X-Request-Id`; it flows into logs and
  `execution_events`.
- Boundary validation with zod; the same zod IR schema is exported as JSON Schema.

## 10. CLI (`xperiment`)

Thin API client only — no engine logic.

```text
xperiment workflow create --name <name> [--definition file.json]
xperiment workflow list | get <id> | validate <id> | publish <id>
xperiment run <workflowId> --input payload.json [--watch]
xperiment execution get <id>
```

`--watch` polls the execution until terminal and renders a node timeline with
per-attempt status and latency. Config via `XPERIMENT_API_URL` (default
`http://localhost:3000`).

## 11. Logging and observability

- pino structured JSON in every service: `requestId`, `executionId`, `nodeId`,
  `attempt`, `event` code, level.
- No payload bodies or header values in logs by default (pre-credential hygiene per
  HLD §14.4 spirit).
- `execution_events` is the product-facing trail; logs are operational.
- OpenTelemetry deferred to Phase 1.

## 12. Testing strategy (TDD, ≥ 80% coverage)

- **Unit** (bulk): expression parser/evaluator incl. prototype-pollution rejection and
  position-annotated errors; graph validators (cycles, reachability, ports); retry
  classifier; CAS transition rules; SSRF guard (IP range matrix).
- **Integration** (Vitest against Docker Postgres + Redis): outbox publish/consume;
  duplicate delivery dedupe; retry on 503-then-success; stalled-worker redelivery;
  draft revision conflict.
- **E2E** (API-level, all services running): create → publish → execute → poll happy
  path; IF true/false branches with SKIPPED verification; HTTP 500×2-then-200 showing
  3 recorded attempts; duplicate Idempotency-Key returns the same execution; invalid
  IR rejected at validate and publish.
- **Exit-criterion test:** run the same workflow + input N times (N ≥ 5), assert
  identical terminal state and node outcomes each run.
- HTTP fixtures via a local stub server (no external network in tests).

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Full service split adds coordination overhead for a proof | Shared packages keep logic pure/testable; services are thin shells over `engine-core` |
| Outbox loop bugs cause stuck executions | Integration tests for crash-between-commit-and-publish; outbox `attempts` counter + log alert on repeated failure |
| BullMQ stalled-job semantics misunderstood | Dedicated integration test kills a worker mid-task and asserts redelivery + single committed result |
| JSONB payload growth | 256 KB cap enforced at write; `*_ref` migration path documented |
| Windows dev environment friction (Docker Desktop) | Compose only for Postgres/Redis; services run natively via tsx |

## 14. What Phase 1 inherits

The seams this design deliberately leaves open: trigger registry (webhook/schedule),
credential vault + `connectionRef`, object storage payload refs, wait/resume +
timer service, cancellation, OTEL, multi-tenant auth/RLS, canvas/`layout_json`
(drafts already store definition separately so layout can be added), AI builder
(validation layers already return structured findings an AI patch loop can consume).
