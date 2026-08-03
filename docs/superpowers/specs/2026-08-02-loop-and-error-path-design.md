# Loop and Error Path Design

**Status:** approved 2026-08-02
**Requirements:** PRD LOGIC-002 ("Loop memiliki max iterations dan concurrency limit") and
LOGIC-004 ("Error path dapat dikonfigurasi per node dan global"). Both priority **Must**,
both entirely absent.

## 1. Scope

One slice covering both, at the user's explicit choice. I raised the case for splitting —
the error path is a change to one pure function, the loop rewrites how work is scheduled —
and the user chose to keep them together. The implementation plan is therefore phased
(error path → expansion → concurrency → canvas), each phase with its own test cycle and
commit, so a reviewer can still reject one phase while accepting its neighbour.

Out of scope, deliberately: cross-iteration aggregation of outputs (§4), nested loops
(a loop inside a loop body — rejected by validation), and EXE-009 object storage for large
payloads.

### What exists today

- `computeReadiness(ir, outcomes)` in `packages/engine-core/src/readiness.ts` is a pure
  function over one outcome per node id. `latestNodeStates` enforces that with
  `SELECT DISTINCT ON (node_id)` (`packages/db/src/repos/executions.ts:291`).
- `outputPort` already decides which edges are active: `port.get(e.from) ?? 'main'`.
  `core.if` returns `outputPort: 'true' | 'false'` and declares `outputPorts` in its
  connector definition, which `validateGraph` checks (`unknown_output_port`).
- Every edge must target the port `'input'`; only **output** ports vary.
- Cycles are rejected (`cycle_detected`, `packages/ir/src/graph.ts:61`).
- `apps/orchestrator/src/handlers/nodeCompleted.ts:56` short-circuits on a FAILED node:
  it skips every PENDING node and fails the execution without consulting readiness.

## 2. Error path

### IR

```ts
// irNodeSchema.settings gains:
onError: z.enum(['fail', 'continue']).optional()

// workflowIrSchema.metadata gains:
onError: z.enum(['fail', 'continue']).optional()   // workflow-wide default, itself defaulting to 'fail'
```

The port `error` is accepted as `from.port` on an edge out of **any** node, without the
connector declaring it. `validateGraph`'s `unknown_output_port` check exempts it. Requiring
all seventeen connectors to declare an `error` port would be churn with no information in it.

### Semantics

A node that fails is recorded as **FAILED** in `execution_nodes`, always. The database
records what happened; the scheduler decides what it means. Given a FAILED node,
`computeReadiness` resolves:

| Condition | Active port | Execution |
|---|---|---|
| An edge leaves the node on port `error` | `error` | continues |
| No error edge, effective policy `continue` | `main` | continues |
| No error edge, effective policy `fail` | none | terminal FAILED |

Effective policy is `node.settings.onError ?? ir.metadata.onError ?? 'fail'`, so the default
is exactly today's behaviour and every existing workflow keeps its meaning.

`computeReadiness` already receives the IR, so it derives all of this itself. No new
argument, the function stays pure, and the whole change is unit-testable without a database.

### Consequences elsewhere

- **`nodeCompleted.ts` loses its FAILED branch.** A failure now flows into the same
  readiness path as a success and only ends the execution when readiness returns
  `terminal === 'FAILED'`. The handler gets shorter, not longer.
- **`succeededOutputs` must include handled failures**, carrying `{ error: <normalized> }`
  as that node's output. Without this an expression downstream of an error edge has nothing
  to read, and the branch that exists to handle the failure cannot see it.
- The `terminal` rule changes from "any node FAILED" to "any node FAILED **and** unhandled".

## 3. Loop

### IR

A new core connector `core.loop`:

- `outputPorts: ['item', 'done']`
- parameters: `items` (an expression resolving to an array), `maxIterations`
  (int, default 100, max 1000), `concurrency` (int, default 1, max 10).
- `run()` validates and reports the item count. It does **not** run the body — the
  orchestrator does, by rewriting the graph.

Body nodes stay in the top-level `nodes` array and carry a scope marker:

```ts
// irNodeSchema gains:
scope: z.object({ loopId: z.string() }).strict().optional()
```

Keeping the body flat means the React Flow canvas, layout, diff, hash, validation and the
node palette all keep working unchanged; the expansion is purely a runtime concern.

### Runtime expansion

One new pure function in `@xperiment/engine-core`:

```ts
expandLoops(ir: WorkflowIR, iterationCounts: Record<string, number>): WorkflowIR
```

`iterationCounts` comes from the loop node's own recorded output: until the loop node has
succeeded its count is unknown, that loop is left **unexpanded**, and its scoped body nodes
are therefore absent from the derived IR and unschedulable. This is what stops a body node
from running before the loop that owns it.

For each loop with a known item count N it produces a derived IR in which:

- every node scoped to that loop is cloned N times as `body#0` … `body#(N-1)`;
- every edge between two nodes of that scope is cloned within each iteration;
- the loop's `item` edge becomes N edges, one into each iteration's entry node;
- a synthetic join node `loop$join` takes an inbound edge from each iteration's exit node,
  and the loop's original `done` edges are rewired to leave the join.

**N = 0 is a special case and must be written as one.** With no iterations the join would
have no inbound edges at all, and `computeReadiness` skips a node with no inbound edges
entirely — it treats it as an entrypoint the orchestrator seeds directly
(`readiness.ts`, `if (edges.length === 0) continue`). The join would never fire and `done`
would hang. So when N = 0 the expansion emits **no join**: the loop's original `done` edges
stay attached to the loop node itself, which has already succeeded, and the flow continues
immediately. A test for the empty loop is not an edge-case nicety here; without it this
design hangs.

A single-node body is legal: that node is both the scope's entry and its exit.

The orchestrator then runs the **existing, unmodified `computeReadiness`** over that derived
IR. The scheduler never learns what a loop is; loops are a graph rewrite.

**No migration.** The IR id pattern `^[A-Za-z][A-Za-z0-9_-]{0,63}$` forbids both `#` and `$`,
so neither an instance id nor a join id can ever collide with an authored node id, and both
encodings are unambiguous and reversible. `execution_nodes.node_id` holds the instance id as
it is; `latestNodeStates`, the unique key `(execution_id, node_id, attempt)`, `casNode` and
`insertNodeAttempt` are all untouched. The convention lives in two functions in engine-core,
`instanceId(nodeId, iteration)` and `parseInstanceId(id)`, and nowhere else.

The join node is virtual: the orchestrator completes it itself once all its inbound
instances are decided, rather than dispatching it to a worker.

### Concurrency

The limit cannot come from readiness, which will mark all N iterations ready at once. It is
a dispatch-time throttle: of the ready set, the orchestrator dispatches at most
`concurrency` instances per loop, counting every instance of that loop already in a
non-terminal, non-PENDING state — READY, QUEUED, RUNNING, WAITING or RETRY_SCHEDULED.
The rest stay PENDING and are picked up on the next completion, which is exactly what the
existing loop over `readiness.ready` already does for anything it declines to claim.

### Context inside an iteration

`buildContext` needs one adjustment: within iteration *i*, an expression naming a sibling
body node must resolve `body` to the output of `body#i`. Without it, every expression inside
a loop body would have to name an instance id that the author cannot know when editing.

### A failing iteration

No loop-specific rule. A body node that fails obeys its own `onError` and its own `error`
edge, exactly as it would outside a loop. If the failure is unhandled the execution fails,
taking the loop with it. One semantics for the whole product.

### Exceeding `maxIterations`

The loop node **fails**. Exceeding the cap means something is wrong with the input data, and
silent truncation is the hardest class of bug to trace — a run reports SUCCEEDED while
quietly dropping records. Because the error path lands in this same slice, an author who
wants to tolerate it can route the loop's `error` port to a notification branch.

## 4. Aggregation, and the payload cap

The `done` port carries `{ count, succeeded, failed }` and **not** the iteration outputs.

`PAYLOAD_CAP_BYTES = 262144` in `packages/db/src/repos/executions.ts` currently *rejects*
oversized payloads rather than truncating them, so a 500-row loop that aggregated its
outputs would fail the run at the last step, after doing all the work. Carrying only counts
sidesteps the cap entirely and keeps this slice clear of EXE-009 (object storage) and
EXE-010 (truncation and masking), both unbuilt and both their own requirements.

**Stated limitation:** there is no way to collect every iteration's output into one value.
Downstream nodes that need per-item results read them from the iteration context. If
aggregation is wanted later it should arrive with EXE-009, not before it.

## 5. Validation

New findings in `validateGraph`:

- `loop_body_not_single_entry` — the nodes of one scope must form a sub-graph with exactly
  one node having no inbound edge from within the scope, and exactly one with no outbound
  edge within it. A one-node body satisfies both with the same node.
- `empty_loop_body` — a `core.loop` node with no scoped nodes at all. Its `item` port would
  lead nowhere.
- `scoped_node_as_entrypoint` — a node carrying `scope` may not be an entrypoint.
- `cross_scope_edge` — an edge may not cross a scope boundary except the loop's own `item`
  edge into the body entry, and the body exit's edge back to its loop.
- `unknown_loop_scope` — `scope.loopId` must name a `core.loop` node.
- `nested_loop_unsupported` — a `core.loop` node may not itself carry a `scope`.

`maxIterations` and `concurrency` bounds are enforced by the connector's params schema, so a
bad value is a validation finding rather than a runtime surprise.

The existing `cycle_detected` rule stays exactly as it is: the flat body plus the `item`/
`done` ports keep the authored graph acyclic, which is why this design does not need to
relax it.

## 6. Canvas

- `core.loop` renders as a container with its two output ports; nodes carrying its
  `scope.loopId` are drawn inside it.
- Dropping a node inside the container sets its `scope`; dragging it out clears it.
- The execution timeline groups instances: `body#3` displays as "body — iteration 4".
- A node with an `error` edge shows a second, visually distinct output handle, so an error
  route is legible at a glance rather than hidden in a settings panel.

## 7. Testing

`expandLoops` and `computeReadiness` are both pure, so the core of this slice is tested
without a database at all.

- **Error path:** an error edge routes and the run survives; `continue` without an edge
  proceeds on `main` with the error as output; the default stays `fail` so every existing
  workflow keeps its behaviour; a handled failure still records FAILED on the node; a
  downstream expression can read `{ error: … }`.
- **Expansion:** N iterations produce N clones with edges cloned per iteration; the join
  waits for all of them; a zero-item loop skips the body and fires `done`; `parseInstanceId`
  round-trips; expansion of an IR with no loops returns an equivalent IR.
- **Concurrency:** with `concurrency: 2` and 50 items, at most two instances are ever
  non-PENDING at once.
- **Loop with a durable wait:** a `core.delay` inside the body suspends and resumes per
  iteration — the property that ruled out the container-node approach, so it is worth a test
  that would catch a regression to it.
- **Break-it checks, both required:** remove the error-edge lookup and prove a handled
  failure kills the execution again; remove the dispatch throttle and prove 50 iterations
  fly at once past `concurrency: 2`.
- Coverage stays at the repo's 80% thresholds. The full suite runs with `pnpm test`, never
  `pnpm -r test`.
