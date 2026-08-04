# Loop and Error Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `core.loop` node with a max-iteration cap and a concurrency limit, plus a configurable error path per node and workflow-wide (PRD LOGIC-002 and LOGIC-004).

**Architecture:** The error path is a change to one pure function — `computeReadiness` already receives the IR, so it can decide for itself whether a failure was handled. The loop is a **graph rewrite**: a new pure `expandLoops` clones scoped body nodes per iteration into a derived IR, and the existing scheduler runs over that unchanged. Because the IR id pattern forbids `#` and `$`, instance and join ids can never collide with authored ids, so there is **no migration**.

**Tech Stack:** pnpm monorepo, ESM, tsx (runs TS source — no build step), TypeScript strict with `noUncheckedIndexedAccess`, Vitest 2, Fastify 5 api, BullMQ worker + orchestrator, Postgres, Next.js 14 app router with React Flow.

## Global Constraints

- Run the full suite with `pnpm test`. **Never `pnpm -r test`** — the root script pins `--workspace-concurrency=1`, and concurrent packages make `@xperiment/queue`'s outbox publisher race others over `task_outbox`.
- Coverage thresholds are 80% on lines, statements, functions and branches, per package.
- Conventional commit subjects, `<type>: <description>`, **no attribution trailer**.
- No `console.log`.
- **No database migration in this slice.** Instance ids are encoded in `execution_nodes.node_id`; the unique key `(execution_id, node_id, attempt)` and `latestNodeStates` are untouched.
- The default error policy is `fail`, which is exactly today's behaviour — **every existing workflow must keep its meaning**.
- `expandLoops` and `computeReadiness` are pure. They take no clock, no pool, no registry.
- The `done` port carries counts, never aggregated iteration outputs (spec §4).

---

### Task 1: The error path in the IR and in readiness

**Files:**
- Modify: `packages/ir/src/schema.ts`, `packages/ir/src/types.ts`, `packages/ir/src/graph.ts`
- Modify: `packages/engine-core/src/readiness.ts`
- Test: `packages/engine-core/test/readiness.test.ts`, `packages/ir/test/validate.test.ts`

**Interfaces:**
- Consumes: `WorkflowIR` from `@xperiment/ir`; `NodeStatus` from `./states.js`.
- Produces: `irNodeSchema.settings.onError?: 'fail' | 'continue'`; `workflowIrSchema.metadata.onError?: 'fail' | 'continue'`; `errorRouting(ir, nodeId): { port: string } | null` exported from `@xperiment/engine-core`; `computeReadiness` unchanged in signature.

- [ ] **Step 1: Write the failing readiness tests**

Append to `packages/engine-core/test/readiness.test.ts`. The file already has an `ir()` helper
taking `nodes` and `[from, to, port?]` edge tuples, and an `o()` helper for outcomes — reuse them.

```ts
describe('error path', () => {
  // t → a → b, plus a → handler on the error port
  const routed = ir(
    [{ id: 't' }, { id: 'a' }, { id: 'b' }, { id: 'h' }],
    [
      ['t', 'a'],
      ['a', 'b'],
      ['a', 'h', 'error'],
    ],
  );

  test('a failure with an error edge routes there and the run survives', () => {
    const r = computeReadiness(routed, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual(['h']);
    expect(r.skipped).toEqual(['b']);
    expect(r.terminal).toBeNull();
  });

  test('a failure with no error edge still ends the run', () => {
    // Nothing changed for the default policy — every existing workflow keeps its meaning.
    const plain = ir([{ id: 't' }, { id: 'a' }, { id: 'b' }], [['t', 'a'], ['a', 'b']]);
    const r = computeReadiness(plain, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual([]);
    expect(r.terminal).toBe('FAILED');
  });

  test("policy 'continue' on the node carries on down main", () => {
    const plain = ir([{ id: 't' }, { id: 'a' }, { id: 'b' }], [['t', 'a'], ['a', 'b']]);
    const withPolicy: WorkflowIR = {
      ...plain,
      nodes: plain.nodes.map((n) => (n.id === 'a' ? { ...n, settings: { onError: 'continue' as const } } : n)),
    };
    const r = computeReadiness(withPolicy, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual(['b']);
    expect(r.terminal).toBeNull();
  });

  test('the workflow-wide default applies when the node says nothing', () => {
    const plain = ir([{ id: 't' }, { id: 'a' }, { id: 'b' }], [['t', 'a'], ['a', 'b']]);
    const withDefault: WorkflowIR = { ...plain, metadata: { onError: 'continue' } };
    expect(computeReadiness(withDefault, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]).ready).toEqual(['b']);
  });

  test('the node setting beats the workflow default', () => {
    const plain = ir([{ id: 't' }, { id: 'a' }, { id: 'b' }], [['t', 'a'], ['a', 'b']]);
    const mixed: WorkflowIR = {
      ...plain,
      metadata: { onError: 'continue' },
      nodes: plain.nodes.map((n) => (n.id === 'a' ? { ...n, settings: { onError: 'fail' as const } } : n)),
    };
    expect(computeReadiness(mixed, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]).terminal).toBe('FAILED');
  });

  test('an error edge wins over a fail policy', () => {
    // The edge is the author's explicit instruction; the policy is only the fallback.
    const explicit: WorkflowIR = {
      ...routed,
      nodes: routed.nodes.map((n) => (n.id === 'a' ? { ...n, settings: { onError: 'fail' as const } } : n)),
    };
    const r = computeReadiness(explicit, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual(['h']);
    expect(r.terminal).toBeNull();
  });

  test('the run completes once the error branch finishes', () => {
    const r = computeReadiness(routed, [o('t', 'SUCCEEDED'), o('a', 'FAILED'), o('h', 'SUCCEEDED')]);
    expect(r.terminal).toBe('SUCCEEDED');
  });

  test('a downstream node still waits for an undecided sibling', () => {
    const fan = ir(
      [{ id: 't' }, { id: 'a' }, { id: 'c' }, { id: 'j' }],
      [
        ['t', 'a'],
        ['t', 'c'],
        ['a', 'j'],
        ['c', 'j'],
      ],
    );
    const withPolicy: WorkflowIR = { ...fan, metadata: { onError: 'continue' } };
    const r = computeReadiness(withPolicy, [o('t', 'SUCCEEDED'), o('a', 'FAILED')]);
    expect(r.ready).toEqual([]); // c has not run yet
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @xperiment/engine-core exec vitest run test/readiness.test.ts -t "error path"
```

Expected: FAIL — the first case reports `expected [] to equal [ 'h' ]`, because a FAILED node
currently makes the run terminal and activates nothing.

- [ ] **Step 3: Widen the IR schema**

In `packages/ir/src/schema.ts`, add `onError` to `irNodeSchema.settings`:

```ts
    settings: z
      .object({
        timeoutMs: z.number().int().min(1).max(300000).optional(),
        retry: retryPolicySchema.optional(),
        // What happens when this node fails and no `error` edge leaves it. Defaults to the
        // workflow-wide setting, which itself defaults to 'fail' — today's behaviour.
        onError: z.enum(['fail', 'continue']).optional(),
      })
      .strict()
      .optional(),
```

and to `workflowIrSchema.metadata`:

```ts
    metadata: z
      .object({
        executionTimeoutMs: z.number().int().min(1000).max(86400000).optional(),
        onError: z.enum(['fail', 'continue']).optional(),
        layout: z
          .record(z.string(), z.object({ x: z.number(), y: z.number() }).strict())
          .optional(),
      })
      .strict()
      .optional(),
```

In `packages/ir/src/types.ts`, mirror both onto the hand-written types — find the interface
carrying `timeoutMs` and `retry` and add `onError?: 'fail' | 'continue'`, and the metadata
interface and add the same.

- [ ] **Step 4: Exempt the `error` port from output-port validation**

In `packages/ir/src/graph.ts`, the `unknown_output_port` check currently reads:

```ts
      const info = registry.get(from.type);
      if (info && !info.outputPorts.includes(e.from.port)) {
```

Change it to:

```ts
      const info = registry.get(from.type);
      // `error` is offered implicitly by every node. Making seventeen connectors declare it
      // would be churn carrying no information.
      if (info && e.from.port !== 'error' && !info.outputPorts.includes(e.from.port)) {
```

- [ ] **Step 5: Rewrite readiness around a single resolution step**

Replace the body of `packages/engine-core/src/readiness.ts` from the `export function computeReadiness`
line to the end of the file with:

```ts
/**
 * Where a node's failure goes. An explicit `error` edge is the author's instruction and wins;
 * otherwise the effective policy decides between carrying on down `main` and ending the run.
 * Returns null when the failure is fatal.
 */
export function errorRouting(ir: WorkflowIR, nodeId: string): { port: string } | null {
  if (ir.edges.some((e) => e.from.nodeId === nodeId && e.from.port === 'error')) return { port: 'error' };
  const node = ir.nodes.find((n) => n.id === nodeId);
  const policy = node?.settings?.onError ?? ir.metadata?.onError ?? 'fail';
  return policy === 'continue' ? { port: 'main' } : null;
}

/** What a node's recorded state means for scheduling. */
interface Resolved {
  /** The node will not change again, so downstream may be decided. */
  decided: boolean;
  /** Which outgoing port is live; null when none is. */
  activePort: string | null;
  /** An unhandled failure: the execution is over. */
  fatal: boolean;
}

export function computeReadiness(ir: WorkflowIR, outcomes: NodeOutcome[]): ReadinessResult {
  const status = new Map<string, NodeStatus>(outcomes.map((o) => [o.nodeId, o.status]));
  const port = new Map<string, string | null>(outcomes.map((o) => [o.nodeId, o.outputPort ?? null]));
  const inbound = new Map<string, { from: string; port: string }[]>();
  for (const n of ir.nodes) inbound.set(n.id, []);
  for (const e of ir.edges) inbound.get(e.to.nodeId)?.push({ from: e.from.nodeId, port: e.from.port });

  const skipped = new Set<string>();
  const raw = (id: string): NodeStatus => (skipped.has(id) ? 'SKIPPED' : (status.get(id) ?? 'PENDING'));

  const resolve = (id: string): Resolved => {
    const s = raw(id);
    if (s === 'SUCCEEDED') return { decided: true, activePort: port.get(id) ?? 'main', fatal: false };
    if (s === 'SKIPPED') return { decided: true, activePort: null, fatal: false };
    if (s === 'FAILED') {
      const routed = errorRouting(ir, id);
      return routed
        ? { decided: true, activePort: routed.port, fatal: false }
        : { decided: true, activePort: null, fatal: true };
    }
    return { decided: false, activePort: null, fatal: false };
  };

  // Propagate skips to fixpoint: a PENDING node all of whose inbound edges are inactive
  // becomes SKIPPED. An unhandled failure has no active port, so it skips its downstream
  // here rather than in the orchestrator.
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of ir.nodes) {
      const edges = inbound.get(n.id)!;
      if (edges.length === 0) continue; // entrypoint, or a synthetic join the orchestrator seeds
      if (raw(n.id) !== 'PENDING') continue;
      const allInactive = edges.every((e) => {
        const r = resolve(e.from);
        return r.decided && r.activePort !== e.port;
      });
      if (allInactive) {
        skipped.add(n.id);
        changed = true;
      }
    }
  }

  const ready: string[] = [];
  for (const n of ir.nodes) {
    const edges = inbound.get(n.id)!;
    if (edges.length === 0) continue;
    if (raw(n.id) !== 'PENDING') continue;
    const active = edges.filter((e) => {
      const r = resolve(e.from);
      return r.decided && r.activePort === e.port;
    });
    const undecided = edges.some((e) => !resolve(e.from).decided);
    if (active.length > 0 && !undecided) ready.push(n.id);
  }

  const resolved = ir.nodes.map((n) => resolve(n.id));
  let terminal: ReadinessResult['terminal'] = null;
  if (resolved.some((r) => r.fatal)) terminal = 'FAILED';
  else if (resolved.every((r) => r.decided)) terminal = 'SUCCEEDED';

  return { ready, skipped: [...skipped], terminal };
}
```

Export `errorRouting` from `packages/engine-core/src/index.ts`, beside `computeReadiness`:

```ts
export { computeReadiness, errorRouting, type NodeOutcome, type ReadinessResult } from './readiness.js';
```

- [ ] **Step 6: Run the engine-core and ir suites**

```bash
pnpm --filter @xperiment/engine-core test && pnpm --filter @xperiment/ir test
```

Expected: PASS. The pre-existing readiness tests must pass **unchanged** — they encode the
default `fail` behaviour, which is the guarantee that no existing workflow shifts meaning.

- [ ] **Step 7: Break the error-edge lookup and watch the tests catch it**

In `errorRouting`, temporarily neuter the edge check:

```ts
  if (false && ir.edges.some((e) => e.from.nodeId === nodeId && e.from.port === 'error')) return { port: 'error' };
```

Run:

```bash
pnpm --filter @xperiment/engine-core exec vitest run test/readiness.test.ts -t "error path"
```

Expected: **FAIL** on `a failure with an error edge routes there and the run survives` and on
`an error edge wins over a fail policy` — the run reports `terminal: 'FAILED'` and the handler
never becomes ready. That is a workflow whose author wired an explicit failure branch watching
it be ignored. Restore the line and re-run: Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/ir/src packages/engine-core/src packages/engine-core/test packages/ir/test
git commit -m "feat: route node failures down a configurable error path"
```

---

### Task 2: Wire the error path through the orchestrator and node outputs

**Files:**
- Modify: `apps/orchestrator/src/handlers/nodeCompleted.ts`
- Modify: `packages/db/src/repos/executions.ts`, `packages/db/src/index.ts`
- Modify: `apps/worker/src/runTask.ts:158`
- Test: `apps/orchestrator/test/nodeCompleted.test.ts`

**Interfaces:**
- Consumes: `computeReadiness` and `errorRouting` from Task 1.
- Produces: `nodeOutputs(db, executionId): Promise<Record<string, unknown>>` replacing `succeededOutputs`; a failed node's entry is `{ error: <error_json> }`.

- [ ] **Step 1: Write the failing orchestrator test**

Append to `apps/orchestrator/test/nodeCompleted.test.ts`, following the seeding helpers already
in `apps/orchestrator/test/helpers.ts`:

```ts
test('a failed node with an error edge continues the run down that branch', async () => {
  const seeded = await seedExecution({
    nodes: [{ id: 't' }, { id: 'a' }, { id: 'b' }, { id: 'h' }],
    edges: [
      ['t', 'a'],
      ['a', 'b'],
      ['a', 'h', 'error'],
    ],
  });
  await markNode(seeded.executionId, 't', 'SUCCEEDED');
  await markNode(seeded.executionId, 'a', 'FAILED');

  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'a', attempt: 1, status: 'FAILED' });

  const states = await latestNodeStates(pool, seeded.executionId);
  const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
  expect(byId['h']).toBe('QUEUED');
  expect(byId['b']).toBe('SKIPPED');
  const exec = await getExecution(pool, seeded.executionId);
  expect(exec.status).toBe('RUNNING'); // the run is not over
});

test('a failed node with no error edge still fails the execution', async () => {
  const seeded = await seedExecution({
    nodes: [{ id: 't' }, { id: 'a' }, { id: 'b' }],
    edges: [
      ['t', 'a'],
      ['a', 'b'],
    ],
  });
  await markNode(seeded.executionId, 't', 'SUCCEEDED');
  await markNode(seeded.executionId, 'a', 'FAILED');

  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'a', attempt: 1, status: 'FAILED' });

  const exec = await getExecution(pool, seeded.executionId);
  expect(exec.status).toBe('FAILED');
});
```

If `seedExecution` in `helpers.ts` does not accept `nodes`/`edges`, extend it to build an IR
the same way `packages/engine-core/test/readiness.test.ts`'s `ir()` helper does, and to insert
a workflow version carrying it.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @xperiment/orchestrator exec vitest run test/nodeCompleted.test.ts -t "error edge"
```

Expected: FAIL — `expected undefined to be 'QUEUED'`; the FAILED short-circuit ends the run
before readiness is ever consulted.

- [ ] **Step 3: Delete the FAILED short-circuit**

In `apps/orchestrator/src/handlers/nodeCompleted.ts`, remove the whole
`if (payload.status === 'FAILED') { … }` block (lines 56–86). Failures now fall through to the
same readiness path as successes. Delete the now-unused `casNode` skip loop it contained;
readiness marks those nodes SKIPPED itself.

Then, in the block that runs after the readiness call, change the FAILED branch's summary so it
names the node when there is one. Replace:

```ts
    } else if (readiness.terminal === 'FAILED') {
      const done = await casExecution({
        executionId,
        from: ['RUNNING'],
        to: 'FAILED',
        completedAt: true,
        errorSummary: 'A node failed',
      });
```

with:

```ts
    } else if (readiness.terminal === 'FAILED') {
      const done = await casExecution(client, {
        executionId,
        from: ['RUNNING'],
        to: 'FAILED',
        completedAt: true,
        errorSummary: payload.status === 'FAILED' ? `Node '${nodeId}' failed` : 'A node failed',
      });
```

Keep the `closeOpenWaits` / `execution.failed` / `enqueueCompletionCallback` /
`recordExecutionUsage` calls exactly as they are — a sibling's wait must still not dangle.

- [ ] **Step 4: Give downstream nodes something to read**

In `packages/db/src/repos/executions.ts`, rename `succeededOutputs` to `nodeOutputs` and widen it:

```ts
/**
 * Every node's value as an expression sees it. A node that failed contributes
 * `{ error: … }` rather than nothing: a branch wired to an `error` port exists precisely to
 * read the failure, and with no entry here it would have nothing to read.
 */
export async function nodeOutputs(db: Db, executionId: string): Promise<Record<string, unknown>> {
  const r = await db.query(
    `SELECT DISTINCT ON (node_id) node_id, status, output_json, error_json
     FROM execution_nodes WHERE execution_id = $1 ORDER BY node_id, attempt DESC`,
    [executionId],
  );
  const out: Record<string, unknown> = {};
  for (const row of r.rows as Record<string, unknown>[]) {
    const id = row['node_id'] as string;
    if (row['status'] === 'SUCCEEDED') out[id] = row['output_json'];
    else if (row['status'] === 'FAILED') out[id] = { error: row['error_json'] };
  }
  return out;
}
```

Update the export in `packages/db/src/index.ts` and the single call site,
`apps/worker/src/runTask.ts:158`, from `succeededOutputs` to `nodeOutputs`. There are no others —
verify with:

```bash
grep -rn "succeededOutputs" --include=*.ts apps packages
```

Expected: no output.

- [ ] **Step 5: Run the orchestrator, worker and db suites**

```bash
pnpm --filter @xperiment/orchestrator test && pnpm --filter @xperiment/worker test && pnpm --filter @xperiment/db test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator apps/worker packages/db
git commit -m "feat: let a handled failure carry the run down its error branch"
```

---

### Task 3: The `core.loop` connector, the scope marker, and validation

**Files:**
- Create: `packages/connectors/src/core/loop.ts`, `packages/connectors/test/loop.test.ts`
- Modify: `packages/connectors/src/registry.ts`, `packages/connectors/src/index.ts`
- Modify: `packages/ir/src/schema.ts`, `packages/ir/src/types.ts`, `packages/ir/src/graph.ts`
- Test: `packages/ir/test/validate.test.ts`

**Interfaces:**
- Consumes: `ConnectorDefinition`, `NodeRunError` from `../types.js`.
- Produces: `coreLoop` with `outputPorts: ['item', 'done']` and output `{ items, count }`; `DEFAULT_MAX_ITERATIONS = 100`; `DEFAULT_CONCURRENCY = 1`; `irNodeSchema.scope?: { loopId: string }`.

- [ ] **Step 1: Write the failing connector test**

Create `packages/connectors/test/loop.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { coreLoop } from '../src/core/loop.js';
import { NodeRunError } from '../src/types.js';

const ctx = (parameters: unknown) =>
  ({ parameters, connection: null, signal: new AbortController().signal }) as never;

describe('core.loop', () => {
  test('reports the items and selects the item port', async () => {
    const r = await coreLoop.run(ctx({ items: ['a', 'b', 'c'] }));
    expect(r.output).toEqual({ items: ['a', 'b', 'c'], count: 3 });
    expect(r.outputPort).toBe('item');
  });

  test('an empty list goes straight to done', async () => {
    // With no iterations there is no join node, so the loop's own `done` edges are the ones
    // that must fire — see the design, §3.
    const r = await coreLoop.run(ctx({ items: [] }));
    expect(r.outputPort).toBe('done');
    expect(r.output).toEqual({ items: [], count: 0 });
  });

  test('refuses a non-array', async () => {
    await expect(coreLoop.run(ctx({ items: { a: 1 } }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('refuses more items than maxIterations, naming both numbers', async () => {
    const err = await coreLoop
      .run(ctx({ items: [1, 2, 3], maxIterations: 2 }))
      .catch((e: unknown) => e as NodeRunError);
    expect(err).toBeInstanceOf(NodeRunError);
    expect(err.code).toBe('too_many_iterations');
    expect(err.message).toContain('3');
    expect(err.message).toContain('2');
    expect(err.retryable).toBe(false);
  });

  test('defaults the cap to 100', async () => {
    const err = await coreLoop
      .run(ctx({ items: Array.from({ length: 101 }, (_, i) => i) }))
      .catch((e: unknown) => e as NodeRunError);
    expect(err.code).toBe('too_many_iterations');
  });

  test('rejects a concurrency outside 1..10', async () => {
    await expect(coreLoop.run(ctx({ items: [1], concurrency: 0 }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreLoop.run(ctx({ items: [1], concurrency: 11 }))).rejects.toBeInstanceOf(NodeRunError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @xperiment/connectors exec vitest run test/loop.test.ts
```

Expected: FAIL — `Failed to load ../src/core/loop.js`.

- [ ] **Step 3: Write the connector**

Create `packages/connectors/src/core/loop.ts`:

```ts
import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

export const DEFAULT_MAX_ITERATIONS = 100;
export const DEFAULT_CONCURRENCY = 1;

const paramsSchema = z
  .object({
    items: z.unknown(),
    maxIterations: z.number().int().min(1).max(1000).optional(),
    concurrency: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const coreLoop: ConnectorDefinition = {
  type: 'core.loop',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['item', 'done'],
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const items = parsed.data.items;
    if (!Array.isArray(items)) {
      throw new NodeRunError(
        'items_not_array',
        `core.loop items must resolve to an array, got ${items === null ? 'null' : typeof items}`,
        false,
      );
    }
    const max = parsed.data.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (items.length > max) {
      // Failing is louder than truncating, and the failure is routable down an error port.
      throw new NodeRunError(
        'too_many_iterations',
        `core.loop received ${items.length} items, above maxIterations ${max}`,
        false,
      );
    }
    // The items ride in the node's own output so each iteration's context can expose
    // loop.item without a second read. Like any node output this is subject to
    // PAYLOAD_CAP_BYTES; a list too large to store fails here, visibly and routably.
    return {
      output: { items, count: items.length },
      // No iterations means no join node, so the loop's own `done` edges must fire.
      outputPort: items.length === 0 ? 'done' : 'item',
    };
  },
};
```

Register it in `packages/connectors/src/registry.ts` — add `import { coreLoop } from './core/loop.js';`
beside the other core imports and `coreLoop,` to the `defs` array after `coreApproval`. Export it
from `packages/connectors/src/index.ts`:

```ts
export { coreLoop, DEFAULT_CONCURRENCY, DEFAULT_MAX_ITERATIONS } from './core/loop.js';
```

- [ ] **Step 4: Add the scope marker to the IR**

In `packages/ir/src/schema.ts`, add to `irNodeSchema` after `connectionRef`:

```ts
    /** Set on a node that lives inside a loop body. */
    scope: z.object({ loopId: z.string() }).strict().optional(),
```

Mirror it on the node interface in `packages/ir/src/types.ts`:

```ts
  scope?: { loopId: string };
```

- [ ] **Step 5: Write the failing validation tests**

Append to `packages/ir/test/validate.test.ts`, matching the style already there (build an IR
object, call the validator, assert on finding codes):

```ts
describe('loop scopes', () => {
  const loopIr = (over: Partial<WorkflowIR> = {}): WorkflowIR => ({
    schemaVersion: '0.1',
    workflow: { id: 'wf', name: 'wf' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      { id: 'lp', kind: 'logic', type: 'core.loop', operationVersion: '0.1.0', parameters: { items: [] } },
      {
        id: 'b',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: {},
        scope: { loopId: 'lp' },
      },
      { id: 'after', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {} },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'lp', port: 'input' } },
      { id: 'e2', from: { nodeId: 'lp', port: 'item' }, to: { nodeId: 'b', port: 'input' } },
      { id: 'e3', from: { nodeId: 'lp', port: 'done' }, to: { nodeId: 'after', port: 'input' } },
    ],
    ...over,
  });

  const codes = (ir: WorkflowIR) => validate(ir, registry).map((f) => f.code);

  test('a one-node body is valid', () => {
    expect(codes(loopIr())).toEqual([]);
  });

  test('a scoped node may not be the entrypoint', () => {
    expect(codes(loopIr({ entrypoints: ['b'] }))).toContain('scoped_node_as_entrypoint');
  });

  test('scope must name a core.loop node', () => {
    const bad = loopIr();
    bad.nodes = bad.nodes.map((n) => (n.id === 'b' ? { ...n, scope: { loopId: 'after' } } : n));
    expect(codes(bad)).toContain('unknown_loop_scope');
  });

  test('a loop with no body is rejected', () => {
    const bad = loopIr();
    bad.nodes = bad.nodes.filter((n) => n.id !== 'b');
    bad.edges = bad.edges.filter((e) => e.to.nodeId !== 'b');
    expect(codes(bad)).toContain('empty_loop_body');
  });

  test('an edge may not cross a scope boundary', () => {
    // Except the loop's own item edge in; an error branch inside a loop must stay inside it.
    const bad = loopIr();
    bad.edges = [...bad.edges, { id: 'e4', from: { nodeId: 'b', port: 'main' }, to: { nodeId: 'after', port: 'input' } }];
    expect(codes(bad)).toContain('cross_scope_edge');
  });

  test('a loop node may not itself be scoped', () => {
    const bad = loopIr();
    bad.nodes = bad.nodes.map((n) => (n.id === 'lp' ? { ...n, scope: { loopId: 'lp' } } : n));
    expect(codes(bad)).toContain('nested_loop_unsupported');
  });

  test('a body with two entries is rejected', () => {
    const bad = loopIr();
    bad.nodes = [
      ...bad.nodes,
      { id: 'b2', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {}, scope: { loopId: 'lp' } },
    ];
    bad.edges = [...bad.edges, { id: 'e5', from: { nodeId: 'lp', port: 'item' }, to: { nodeId: 'b2', port: 'input' } }];
    expect(codes(bad)).toContain('loop_body_not_single_entry');
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

```bash
pnpm --filter @xperiment/ir exec vitest run test/validate.test.ts -t "loop scopes"
```

Expected: FAIL — every code assertion misses, because none of these rules exist.

- [ ] **Step 7: Implement the validation rules**

In `packages/ir/src/graph.ts`, before the `return findings;`, add:

```ts
  // ---- loop scopes ----
  const loopIds = new Set(ir.nodes.filter((n) => n.type === 'core.loop').map((n) => n.id));
  const scopeOf = new Map(ir.nodes.filter((n) => n.scope).map((n) => [n.id, n.scope!.loopId]));

  for (const n of ir.nodes) {
    if (!n.scope) continue;
    if (!loopIds.has(n.scope.loopId)) {
      g('unknown_loop_scope', `Node '${n.id}' is scoped to '${n.scope.loopId}', which is not a core.loop`, n.id);
    }
    if (loopIds.has(n.id)) {
      g('nested_loop_unsupported', `Loop '${n.id}' may not itself sit inside a loop body`, n.id);
    }
    if (ir.entrypoints.includes(n.id)) {
      g('scoped_node_as_entrypoint', `Node '${n.id}' is inside a loop body and cannot be an entrypoint`, n.id);
    }
  }

  for (const loopId of loopIds) {
    const body = ir.nodes.filter((n) => n.scope?.loopId === loopId);
    if (body.length === 0) {
      g('empty_loop_body', `Loop '${loopId}' has no nodes in its body; its 'item' port leads nowhere`, loopId);
      continue;
    }
    const entries = body.filter((n) => !ir.edges.some((e) => e.to.nodeId === n.id && scopeOf.get(e.from.nodeId) === loopId));
    const exits = body.filter((n) => !ir.edges.some((e) => e.from.nodeId === n.id && scopeOf.get(e.to.nodeId) === loopId));
    if (entries.length !== 1 || exits.length !== 1) {
      g(
        'loop_body_not_single_entry',
        `Loop '${loopId}' body must have exactly one entry and one exit, found ${entries.length} and ${exits.length}`,
        loopId,
      );
    }
  }

  for (const e of ir.edges) {
    const fromScope = scopeOf.get(e.from.nodeId);
    const toScope = scopeOf.get(e.to.nodeId);
    if (fromScope === toScope) continue; // both outside, or both in the same body
    // The only legal crossing is the loop's own item edge into its body.
    const isItemEdge = toScope !== undefined && e.from.nodeId === toScope && e.from.port === 'item';
    if (!isItemEdge) {
      g('cross_scope_edge', `Edge '${e.id}' crosses a loop boundary`, e.to.nodeId);
    }
  }
```

- [ ] **Step 8: Run the connectors and ir suites**

```bash
pnpm --filter @xperiment/connectors test && pnpm --filter @xperiment/ir test
```

Expected: PASS. If a catalogue or registry-count test asserts seventeen connectors, update it to
eighteen — that is a real contract change, not a test to silence.

- [ ] **Step 9: Commit**

```bash
git add packages/connectors packages/ir
git commit -m "feat: add the core.loop connector and loop scope validation"
```

---

### Task 4: `expandLoops`, the graph rewrite

**Files:**
- Create: `packages/engine-core/src/expand.ts`, `packages/engine-core/test/expand.test.ts`
- Modify: `packages/engine-core/src/index.ts`

**Interfaces:**
- Consumes: `WorkflowIR` from `@xperiment/ir`.
- Produces: `expandLoops(ir, iterationCounts: Record<string, number>): WorkflowIR`; `instanceId(nodeId, iteration): string`; `parseInstanceId(id): { nodeId: string; iteration: number } | null`; `joinId(loopId): string`; `isJoinId(id): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine-core/test/expand.test.ts`:

```ts
import type { WorkflowIR } from '@xperiment/ir';
import { describe, expect, test } from 'vitest';
import { computeReadiness, expandLoops, instanceId, isJoinId, joinId, parseInstanceId } from '../src/index.js';

/** t → lp, lp --item--> b1 → b2 (both scoped to lp), lp --done--> after */
function loopIr(): WorkflowIR {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf', name: 'wf' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      { id: 'lp', kind: 'logic', type: 'core.loop', operationVersion: '0.1.0', parameters: {} },
      { id: 'b1', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {}, scope: { loopId: 'lp' } },
      { id: 'b2', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {}, scope: { loopId: 'lp' } },
      { id: 'after', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: {} },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'lp', port: 'input' } },
      { id: 'e2', from: { nodeId: 'lp', port: 'item' }, to: { nodeId: 'b1', port: 'input' } },
      { id: 'e3', from: { nodeId: 'b1', port: 'main' }, to: { nodeId: 'b2', port: 'input' } },
      { id: 'e4', from: { nodeId: 'lp', port: 'done' }, to: { nodeId: 'after', port: 'input' } },
    ],
  };
}

describe('instance ids', () => {
  test('round-trip', () => {
    expect(instanceId('b1', 3)).toBe('b1#3');
    expect(parseInstanceId('b1#3')).toEqual({ nodeId: 'b1', iteration: 3 });
  });

  test('an authored id never parses as an instance', () => {
    // The IR id pattern forbids '#', so this can never be ambiguous.
    expect(parseInstanceId('b1')).toBeNull();
    expect(parseInstanceId('b1#x')).toBeNull();
    expect(parseInstanceId('b1#-1')).toBeNull();
  });

  test('join ids are recognisable and distinct', () => {
    expect(joinId('lp')).toBe('lp$join');
    expect(isJoinId('lp$join')).toBe(true);
    expect(isJoinId('lp')).toBe(false);
  });
});

describe('expandLoops', () => {
  test('an IR with no loops comes back unchanged', () => {
    const plain: WorkflowIR = {
      schemaVersion: '0.1',
      workflow: { id: 'wf', name: 'wf' },
      entrypoints: ['t'],
      nodes: [{ id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} }],
      edges: [],
    };
    expect(expandLoops(plain, {})).toEqual(plain);
  });

  test('an unexpanded loop drops its body, so no body node can run early', () => {
    const out = expandLoops(loopIr(), {});
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['after', 'lp', 't']);
    expect(out.edges.some((e) => e.to.nodeId === 'b1')).toBe(false);
    // The done edge survives untouched — an empty loop fires it directly.
    expect(out.edges.find((e) => e.id === 'e4')!.from).toEqual({ nodeId: 'lp', port: 'done' });
  });

  test('three iterations clone the body and its internal edges', () => {
    const out = expandLoops(loopIr(), { lp: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(out.nodes.some((n) => n.id === `b1#${i}`)).toBe(true);
      expect(out.nodes.some((n) => n.id === `b2#${i}`)).toBe(true);
      expect(
        out.edges.some((e) => e.from.nodeId === `b1#${i}` && e.to.nodeId === `b2#${i}`),
      ).toBe(true);
      expect(out.edges.some((e) => e.from.nodeId === 'lp' && e.from.port === 'item' && e.to.nodeId === `b1#${i}`)).toBe(
        true,
      );
    }
    expect(out.nodes.some((n) => n.id === 'lp$join')).toBe(true);
    // done now leaves the join, not the loop.
    expect(out.edges.find((e) => e.to.nodeId === 'after')!.from.nodeId).toBe('lp$join');
  });

  test('iterations never cross: b1#0 has no edge to b2#1', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    expect(out.edges.some((e) => e.from.nodeId === 'b1#0' && e.to.nodeId === 'b2#1')).toBe(false);
  });

  test('the join has no inbound edges — the orchestrator seeds it', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    expect(out.edges.some((e) => e.to.nodeId === 'lp$join')).toBe(false);
  });

  test('the expanded graph schedules every iteration in parallel', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    const r = computeReadiness(out, [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'lp', status: 'SUCCEEDED', outputPort: 'item' },
    ]);
    expect(r.ready.sort()).toEqual(['b1#0', 'b1#1']);
    expect(r.terminal).toBeNull();
  });

  test('after every iteration and the join finish, the run continues to `after`', () => {
    const out = expandLoops(loopIr(), { lp: 2 });
    const r = computeReadiness(out, [
      { nodeId: 't', status: 'SUCCEEDED' },
      { nodeId: 'lp', status: 'SUCCEEDED', outputPort: 'item' },
      { nodeId: 'b1#0', status: 'SUCCEEDED' },
      { nodeId: 'b2#0', status: 'SUCCEEDED' },
      { nodeId: 'b1#1', status: 'SUCCEEDED' },
      { nodeId: 'b2#1', status: 'SUCCEEDED' },
      { nodeId: 'lp$join', status: 'SUCCEEDED' },
    ]);
    expect(r.ready).toEqual(['after']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @xperiment/engine-core exec vitest run test/expand.test.ts
```

Expected: FAIL — `expandLoops is not exported`.

- [ ] **Step 3: Write the rewrite**

Create `packages/engine-core/src/expand.ts`:

```ts
import type { WorkflowIR } from '@xperiment/ir';

const INSTANCE_SEPARATOR = '#';
const JOIN_SUFFIX = '$join';

/**
 * The id of one iteration's copy of a body node. The IR id pattern forbids '#' and '$', so
 * neither this nor a join id can ever collide with an id an author wrote.
 */
export function instanceId(nodeId: string, iteration: number): string {
  return `${nodeId}${INSTANCE_SEPARATOR}${iteration}`;
}

export function parseInstanceId(id: string): { nodeId: string; iteration: number } | null {
  const at = id.lastIndexOf(INSTANCE_SEPARATOR);
  if (at <= 0) return null;
  const suffix = id.slice(at + 1);
  if (!/^\d+$/.test(suffix)) return null;
  return { nodeId: id.slice(0, at), iteration: Number(suffix) };
}

export function joinId(loopId: string): string {
  return `${loopId}${JOIN_SUFFIX}`;
}

export function isJoinId(id: string): boolean {
  return id.endsWith(JOIN_SUFFIX);
}

/**
 * Rewrites loops out of the graph so the scheduler never has to know they exist.
 *
 * A loop whose item count is unknown — it has not succeeded yet — is left unexpanded, and its
 * body nodes are dropped from the derived IR along with every edge touching them. That is what
 * stops a body node from being scheduled before the loop that owns it.
 *
 * A loop with zero items needs no rewrite at all: `core.loop` selects its `done` port in that
 * case, so its original done edges fire directly and no join is emitted.
 */
export function expandLoops(ir: WorkflowIR, iterationCounts: Record<string, number>): WorkflowIR {
  const loopIds = new Set(ir.nodes.filter((n) => n.type === 'core.loop').map((n) => n.id));
  if (loopIds.size === 0) return ir;

  const expanded = new Map<string, number>();
  for (const id of loopIds) {
    const count = iterationCounts[id];
    if (typeof count === 'number' && count > 0) expanded.set(id, count);
  }

  const scopeOf = new Map(ir.nodes.filter((n) => n.scope).map((n) => [n.id, n.scope!.loopId]));

  const nodes = ir.nodes.filter((n) => n.scope === undefined).map((n) => ({ ...n }));
  for (const [loopId, count] of expanded) {
    const body = ir.nodes.filter((n) => n.scope?.loopId === loopId);
    for (let i = 0; i < count; i += 1) {
      for (const n of body) nodes.push({ ...n, id: instanceId(n.id, i) });
    }
    nodes.push({
      id: joinId(loopId),
      kind: 'logic',
      type: 'core.join',
      operationVersion: '0.1.0',
      parameters: {},
    });
  }

  const edges: WorkflowIR['edges'] = [];
  for (const e of ir.edges) {
    const fromScope = scopeOf.get(e.from.nodeId);
    const toScope = scopeOf.get(e.to.nodeId);

    // Wholly inside an expanded body: one copy per iteration, never crossing between them.
    if (fromScope !== undefined && fromScope === toScope) {
      const count = expanded.get(fromScope);
      if (count === undefined) continue; // unexpanded body: dropped with its nodes
      for (let i = 0; i < count; i += 1) {
        edges.push({
          id: `${e.id}${INSTANCE_SEPARATOR}${i}`,
          from: { nodeId: instanceId(e.from.nodeId, i), port: e.from.port },
          to: { nodeId: instanceId(e.to.nodeId, i), port: e.to.port },
        });
      }
      continue;
    }

    // The loop's item edge into its body entry: one per iteration.
    if (toScope !== undefined && e.from.nodeId === toScope) {
      const count = expanded.get(toScope);
      if (count === undefined) continue;
      for (let i = 0; i < count; i += 1) {
        edges.push({
          id: `${e.id}${INSTANCE_SEPARATOR}${i}`,
          from: { nodeId: e.from.nodeId, port: e.from.port },
          to: { nodeId: instanceId(e.to.nodeId, i), port: e.to.port },
        });
      }
      continue;
    }

    // A done edge out of an expanded loop now leaves the join instead.
    if (expanded.has(e.from.nodeId) && e.from.port === 'done') {
      edges.push({ ...e, from: { nodeId: joinId(e.from.nodeId), port: 'main' } });
      continue;
    }

    // Anything still touching a scoped node belongs to an unexpanded body.
    if (fromScope !== undefined || toScope !== undefined) continue;
    edges.push(e);
  }

  return { ...ir, nodes, edges };
}
```

Export it all from `packages/engine-core/src/index.ts`:

```ts
export { expandLoops, instanceId, isJoinId, joinId, parseInstanceId } from './expand.js';
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @xperiment/engine-core test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine-core/src/expand.ts packages/engine-core/test/expand.test.ts packages/engine-core/src/index.ts
git commit -m "feat: expand loop bodies into per-iteration node instances"
```

---

### Task 5: The orchestrator runs the expanded graph

**Files:**
- Modify: `apps/orchestrator/src/deps.ts`, `apps/orchestrator/src/handlers/nodeCompleted.ts`
- Test: `apps/orchestrator/test/nodeCompleted.test.ts`

**Interfaces:**
- Consumes: `expandLoops`, `joinId`, `isJoinId`, `parseInstanceId` from Task 4; `nodeOutputs` from Task 2.
- Produces: `loadIterationCounts(db, executionId, ir): Promise<Record<string, number>>` in `deps.ts`.

- [ ] **Step 1: Write the failing test**

Append to `apps/orchestrator/test/nodeCompleted.test.ts`:

```ts
test('a succeeded loop queues one instance of the body entry per item', async () => {
  const seeded = await seedLoopExecution({ items: ['x', 'y'] });
  await markNode(seeded.executionId, 't', 'SUCCEEDED');
  await markNodeWithOutput(seeded.executionId, 'lp', 'SUCCEEDED', 'item', { items: ['x', 'y'], count: 2 });

  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'lp', attempt: 1, status: 'SUCCEEDED' });

  const states = await latestNodeStates(pool, seeded.executionId);
  const queued = states.filter((s) => s.status === 'QUEUED').map((s) => s.nodeId).sort();
  expect(queued).toEqual(['b1#0', 'b1#1']);
});

test('the join is seeded once every iteration is decided, and the run continues', async () => {
  const seeded = await seedLoopExecution({ items: ['x'] });
  await markNode(seeded.executionId, 't', 'SUCCEEDED');
  await markNodeWithOutput(seeded.executionId, 'lp', 'SUCCEEDED', 'item', { items: ['x'], count: 1 });
  await markNode(seeded.executionId, 'b1#0', 'SUCCEEDED');

  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'b1#0', attempt: 1, status: 'SUCCEEDED' });

  const states = await latestNodeStates(pool, seeded.executionId);
  const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
  expect(byId['lp$join']).toBe('SUCCEEDED');
  expect(byId['after']).toBe('QUEUED');
});

test('an empty loop skips the body entirely and fires done', async () => {
  // core.loop selects the done port for an empty list, so no join is ever created.
  const seeded = await seedLoopExecution({ items: [] });
  await markNode(seeded.executionId, 't', 'SUCCEEDED');
  await markNodeWithOutput(seeded.executionId, 'lp', 'SUCCEEDED', 'done', { items: [], count: 0 });

  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'lp', attempt: 1, status: 'SUCCEEDED' });

  const states = await latestNodeStates(pool, seeded.executionId);
  const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
  expect(byId['after']).toBe('QUEUED');
  expect(states.some((s) => s.nodeId.startsWith('b1#'))).toBe(false);
  expect(byId['lp$join']).toBeUndefined();
});
```

Add `seedLoopExecution` and `markNodeWithOutput` to `apps/orchestrator/test/helpers.ts`.
`seedLoopExecution` builds the IR from Task 4's `loopIr()` — trigger `t`, loop `lp`, body `b1`→`b2`
scoped to `lp`, and `after` on the done port — and inserts it as the execution's workflow version.
`markNodeWithOutput(executionId, nodeId, status, outputPort, output)` inserts an `execution_nodes`
row carrying `output_json` so `nodeOutputs` can read the item count back.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @xperiment/orchestrator exec vitest run test/nodeCompleted.test.ts -t "loop"
```

Expected: FAIL — `expected [] to equal [ 'b1#0', 'b1#1' ]`; nothing expands yet.

- [ ] **Step 3: Read the iteration counts**

In `apps/orchestrator/src/deps.ts`, add:

```ts
/**
 * How many items each loop resolved to, read from the loop node's own recorded output. A loop
 * that has not succeeded is absent from the result, which leaves it unexpanded.
 */
export async function loadIterationCounts(
  db: pg.Pool | pg.PoolClient,
  executionId: string,
  ir: WorkflowIR,
): Promise<Record<string, number>> {
  const loopIds = ir.nodes.filter((n) => n.type === 'core.loop').map((n) => n.id);
  if (loopIds.length === 0) return {};
  const outputs = await nodeOutputs(db, executionId);
  const counts: Record<string, number> = {};
  for (const id of loopIds) {
    const count = (outputs[id] as { count?: unknown } | undefined)?.count;
    if (typeof count === 'number') counts[id] = count;
  }
  return counts;
}
```

with `nodeOutputs` added to the `@xperiment/db` import at the top of the file.

- [ ] **Step 4: Expand before scheduling, and seed the join**

In `apps/orchestrator/src/handlers/nodeCompleted.ts`, inside the `withTx` that computes readiness,
replace the three lines from `const states = await latestNodeStates(client, executionId);` down to
`const readiness = computeReadiness(ctx.ir, outcomes);` with:

```ts
    const states = await latestNodeStates(client, executionId);
    const counts = await loadIterationCounts(client, executionId, ctx.ir);
    const graph = expandLoops(ctx.ir, counts);
    const outcomes: NodeOutcome[] = states.map((s) => ({
      nodeId: s.nodeId,
      status: s.status as NodeStatus,
      outputPort: s.outputPort,
    }));

    // A join has no inbound edges, so readiness will never schedule it. Seed it here the
    // moment every instance of its loop is decided; the readiness pass below then sees it
    // succeeded and lets the loop's `done` edges fire.
    for (const [loopId, count] of Object.entries(counts)) {
      if (count === 0) continue;
      const jid = joinId(loopId);
      if (outcomes.some((o) => o.nodeId === jid)) continue;
      const body = ctx.ir.nodes.filter((n) => n.scope?.loopId === loopId).map((n) => n.id);
      const wanted = body.flatMap((b) => Array.from({ length: count }, (_, i) => instanceId(b, i)));
      const decided = (id: string): boolean => {
        const o = outcomes.find((x) => x.nodeId === id);
        return o !== undefined && ['SUCCEEDED', 'SKIPPED', 'FAILED'].includes(o.status);
      };
      if (!wanted.every(decided)) continue;
      await insertNodeAttempt(client, { executionId, nodeId: jid, attempt: 1, status: 'SUCCEEDED' });
      await appendEvent(client, { executionId, eventType: 'loop.completed', nodeId: loopId, payload: { count } });
      outcomes.push({ nodeId: jid, status: 'SUCCEEDED', outputPort: 'main' });
    }

    const readiness = computeReadiness(graph, outcomes);
```

Then, in the loop that claims ready nodes, keep everything as it is — instance ids are ordinary
node ids as far as `casNode`, `insertOutbox` and the worker are concerned.

Add the imports: `expandLoops`, `instanceId`, `joinId` from `@xperiment/engine-core`, and
`loadIterationCounts` from `../deps.js`.

Note the two remaining `computeReadiness`-adjacent references to `ctx.ir` in the terminal branches
already use `readiness.terminal`, so they need no change.

- [ ] **Step 5: Give each iteration its item**

`packages/expressions/src/evaluator.ts` restricts expression roots:

```ts
const ROOTS = new Set(['trigger', 'nodes', 'execution']);
```

Add `'loop'`, and extend `ExpressionContext`:

```ts
export interface ExpressionContext {
  trigger: { body: unknown };
  nodes: Record<string, { output: unknown }>;
  execution: { id: string };
  /** Present only while a loop body node is running. */
  loop?: { index: number; item: unknown };
}
```

In `packages/engine-core/src/context.ts`, widen `buildContext`:

```ts
export function buildContext(
  executionId: string,
  triggerBody: unknown,
  outputs: Record<string, unknown>,
  loop?: { index: number; item: unknown },
): ExpressionContext {
  const nodes: Record<string, { output: unknown }> = {};
  for (const [nodeId, output] of Object.entries(outputs)) nodes[nodeId] = { output };
  // Inside iteration i, an expression naming a sibling body node means that iteration's copy.
  // The author cannot know the instance id when editing, so alias it here.
  if (loop) {
    for (const [nodeId, output] of Object.entries(outputs)) {
      const parsed = parseInstanceId(nodeId);
      if (parsed && parsed.iteration === loop.index) nodes[parsed.nodeId] = { output };
    }
  }
  return {
    trigger: { body: triggerBody },
    nodes,
    execution: { id: executionId },
    ...(loop ? { loop } : {}),
  };
}
```

with `import { parseInstanceId } from './expand.js';` at the top.

In `apps/worker/src/runTask.ts`, at the call site on line 159, resolve the loop frame first:

```ts
    const outputs = await nodeOutputs(deps.pool, executionId);
    const instance = parseInstanceId(nodeId);
    let loopFrame: { index: number; item: unknown } | undefined;
    if (instance) {
      const authored = ir.nodes.find((n) => n.id === instance.nodeId);
      const loopId = authored?.scope?.loopId;
      const items = loopId ? (outputs[loopId] as { items?: unknown[] } | undefined)?.items : undefined;
      if (Array.isArray(items)) loopFrame = { index: instance.iteration, item: items[instance.iteration] };
    }
    const ctx = buildContext(executionId, triggerBody, outputs, loopFrame);
```

The worker looks up the node definition by `instance.nodeId`, not by the instance id, wherever it
resolves the connector type, parameters, timeout and retry policy — an instance is a copy of the
authored node and carries the authored node's settings. Search `runTask.ts` for `nodeId` used as an
IR lookup key and route each through `parseInstanceId(nodeId)?.nodeId ?? nodeId`.

- [ ] **Step 6: Run the orchestrator, worker and expressions suites**

```bash
pnpm --filter @xperiment/orchestrator test && pnpm --filter @xperiment/worker test && pnpm --filter @xperiment/expressions test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator apps/worker packages/engine-core packages/expressions
git commit -m "feat: run loop bodies as per-iteration instances"
```

---

### Task 6: The concurrency limit

**Files:**
- Modify: `apps/orchestrator/src/handlers/nodeCompleted.ts`
- Test: `apps/orchestrator/test/nodeCompleted.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: no new exports; a dispatch-time throttle.

- [ ] **Step 1: Write the failing test**

```ts
test('concurrency 2 keeps at most two iterations in flight', async () => {
  const seeded = await seedLoopExecution({ items: [1, 2, 3, 4, 5], concurrency: 2 });
  await markNode(seeded.executionId, 't', 'SUCCEEDED');
  await markNodeWithOutput(seeded.executionId, 'lp', 'SUCCEEDED', 'item', {
    items: [1, 2, 3, 4, 5],
    count: 5,
  });

  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'lp', attempt: 1, status: 'SUCCEEDED' });

  const states = await latestNodeStates(pool, seeded.executionId);
  const inFlight = states.filter((s) => s.nodeId.startsWith('b1#') && s.status === 'QUEUED');
  expect(inFlight).toHaveLength(2);
});

test('finishing one iteration lets the next start', async () => {
  const seeded = await seedLoopExecution({ items: [1, 2, 3], concurrency: 1 });
  await markNode(seeded.executionId, 't', 'SUCCEEDED');
  await markNodeWithOutput(seeded.executionId, 'lp', 'SUCCEEDED', 'item', { items: [1, 2, 3], count: 3 });
  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'lp', attempt: 1, status: 'SUCCEEDED' });
  await markNode(seeded.executionId, 'b1#0', 'SUCCEEDED');
  await markNode(seeded.executionId, 'b2#0', 'SUCCEEDED');

  await handleNodeCompleted(deps, { executionId: seeded.executionId, nodeId: 'b2#0', attempt: 1, status: 'SUCCEEDED' });

  const states = await latestNodeStates(pool, seeded.executionId);
  const byId = Object.fromEntries(states.map((s) => [s.nodeId, s.status]));
  expect(byId['b1#1']).toBe('QUEUED');
  expect(byId['b1#2']).toBeUndefined(); // still PENDING, never inserted
});
```

`seedLoopExecution` gains a `concurrency` option written into the loop node's `parameters`.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @xperiment/orchestrator exec vitest run test/nodeCompleted.test.ts -t "concurrency"
```

Expected: FAIL — `expected length 5 to be 2`; every iteration is dispatched at once.

- [ ] **Step 3: Throttle the dispatch**

In `nodeCompleted.ts`, before the `for (const readyId of readiness.ready)` loop, add:

```ts
    // Readiness marks every iteration ready at once; the limit belongs here, at dispatch.
    // Count every instance of the loop that is already under way — anything neither PENDING
    // nor terminal is occupying a slot.
    const ACTIVE = ['READY', 'QUEUED', 'RUNNING', 'WAITING', 'RETRY_SCHEDULED'];
    const budget = new Map<string, number>();
    for (const [loopId, count] of Object.entries(counts)) {
      if (count === 0) continue;
      const loopNode = ctx.ir.nodes.find((n) => n.id === loopId);
      const limit = Number((loopNode?.parameters as { concurrency?: unknown } | undefined)?.concurrency ?? 1);
      const body = new Set(ctx.ir.nodes.filter((n) => n.scope?.loopId === loopId).map((n) => n.id));
      const running = new Set<number>();
      for (const s of states) {
        const parsed = parseInstanceId(s.nodeId);
        if (parsed && body.has(parsed.nodeId) && ACTIVE.includes(s.status)) running.add(parsed.iteration);
      }
      budget.set(loopId, Math.max(0, limit - running.size));
    }

    const loopOf = new Map(ctx.ir.nodes.filter((n) => n.scope).map((n) => [n.id, n.scope!.loopId]));
    const startingIterations = new Map<string, Set<number>>();
```

and inside the ready loop, before `casNode`, add the guard:

```ts
    for (const readyId of readiness.ready) {
      const parsed = parseInstanceId(readyId);
      const owner = parsed ? loopOf.get(parsed.nodeId) : undefined;
      if (owner !== undefined) {
        const started = startingIterations.get(owner) ?? new Set<number>();
        // An iteration already under way costs nothing more; only a new one spends budget.
        if (!started.has(parsed!.iteration)) {
          const left = budget.get(owner) ?? 0;
          if (left <= 0) continue; // stays PENDING; the next completion picks it up
          budget.set(owner, left - 1);
          started.add(parsed!.iteration);
          startingIterations.set(owner, started);
        }
      }
      const claimed = await casNode(client, { … });   // unchanged from here down
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @xperiment/orchestrator test
```

Expected: PASS.

- [ ] **Step 5: Break the throttle and watch the test catch it**

Change the guard to `if (false && left <= 0) continue;`. Run:

```bash
pnpm --filter @xperiment/orchestrator exec vitest run test/nodeCompleted.test.ts -t "concurrency 2"
```

Expected: **FAIL** — `expected length 5 to be 2`. Five iterations fly at once against a stated
limit of two; against a rate-limited connector that is exactly the burst the setting exists to
prevent. Restore the guard and re-run: Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator
git commit -m "feat: hold loop iterations to the configured concurrency"
```

---

### Task 7: Canvas

**Files:**
- Modify: `apps/web/src/components/canvas/` (the React Flow node and edge components), `apps/web/src/lib/` (IR ↔ flow mapping)
- Test: `apps/web/test/irCanvas.test.ts`

**Interfaces:**
- Consumes: `scope`, `settings.onError` from Tasks 1 and 3.
- Produces: no new exports; a loop container node, an error handle, and iteration grouping in the timeline.

- [ ] **Step 1: Write the failing mapping tests**

`apps/web/test/irCanvas.test.ts` already round-trips IR to React Flow nodes and back. Append:

```ts
test('a scoped node maps to a child of its loop container', () => {
  const flow = irToFlow(loopIrFixture());
  const child = flow.nodes.find((n) => n.id === 'b1')!;
  expect(child.parentNode).toBe('lp');
  expect(child.extent).toBe('parent');
});

test('dropping a node into a loop container sets its scope', () => {
  const ir = flowToIr({ ...loopFlowFixture(), nodes: withParent('b1', 'lp') });
  expect(ir.nodes.find((n) => n.id === 'b1')!.scope).toEqual({ loopId: 'lp' });
});

test('dragging a node out of a container clears its scope', () => {
  const ir = flowToIr({ ...loopFlowFixture(), nodes: withParent('b1', undefined) });
  expect(ir.nodes.find((n) => n.id === 'b1')!.scope).toBeUndefined();
});

test('a node with an error edge renders a second, distinct handle', () => {
  const flow = irToFlow(errorEdgeIrFixture());
  const handles = flow.nodes.find((n) => n.id === 'a')!.data.outputPorts;
  expect(handles).toContain('error');
});
```

Write `loopIrFixture`, `loopFlowFixture`, `errorEdgeIrFixture` and `withParent` beside the other
fixtures already in that file, mirroring the loop IR from Task 4.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @xperiment/web exec vitest run test/irCanvas.test.ts
```

Expected: FAIL — `expected undefined to be 'lp'`.

- [ ] **Step 3: Map scope to React Flow parenting**

In the IR→flow direction, a node carrying `scope.loopId` gets `parentNode: <loopId>` and
`extent: 'parent'`; the loop node itself gets `type: 'loopContainer'` and a size large enough to
hold its body. In the flow→IR direction, `parentNode` becomes `scope: { loopId: parentNode }` and
its absence removes `scope` entirely — write `undefined`, never `{ loopId: undefined }`, or the
strict schema rejects the draft.

- [ ] **Step 4: Render the container and the error handle**

Add a `loopContainer` node component that draws a titled, resizable frame with two source handles,
`item` on the inside edge and `done` on the outside. In the standard node component, render a
second source handle with id `error`, visually distinct (the codebase's coral token,
`var(--color-coral)`, already marks failure), so an error route is legible on the canvas rather
than buried in a settings panel.

In the execution timeline component, group rows whose node id parses as an instance: display
`b1#3` as `b1 — iteration 4` nested under its loop.

- [ ] **Step 5: Typecheck and run the web suite**

```bash
pnpm --filter @xperiment/web typecheck && pnpm --filter @xperiment/web test
```

Expected: exit 0, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: draw loop containers and error routes on the canvas"
```

---

### Task 8: Documentation, an end-to-end scenario, and full verification

**Files:**
- Modify: `README.md`, `e2e/test/` (a new scenario)

- [ ] **Step 1: Document it**

Add to `README.md`, after the execution-model section:

```markdown
### Loops and error paths

`core.loop` takes an array and runs the nodes scoped to it once per item. The body stays in the
top-level node list carrying `scope: { loopId }`; at run time the orchestrator rewrites the graph,
cloning each body node per iteration as `b1#0`, `b1#1`, … and adding a synthetic `lp$join` that the
loop's `done` edges leave from. The scheduler itself knows nothing about loops. Because the IR id
pattern forbids `#` and `$`, these ids can never collide with an authored one, and no migration was
needed.

Each instance keeps its own status, retry, timeout and timeline row, and can suspend — so
`core.delay` and `core.approval` work **inside** a loop body.

`maxIterations` (default 100, max 1000) caps the list; exceeding it **fails the loop node** rather
than truncating silently. `concurrency` (default 1, max 10) bounds how many iterations are in
flight; the limit is applied at dispatch, not in the scheduler.

`done` carries `{ count, succeeded, failed }` and **not** the iteration outputs. Aggregating them
would run into `PAYLOAD_CAP_BYTES` at the last step, after all the work; collecting results across
iterations belongs with EXE-009 object storage and is not built.

An error path is configured per node with `settings.onError` and workflow-wide with
`metadata.onError`, both `fail` (the default, and today's behaviour) or `continue`. An explicit
edge on a node's `error` port wins over either. A node that fails is still recorded **FAILED** —
the database records what happened, the scheduler decides what it means — and a handled failure
contributes `{ error: … }` so the branch handling it can read the failure. Inside a loop body an
error edge must stay inside that body.
```

- [ ] **Step 2: Add the end-to-end scenario**

Add to the `e2e` package a scenario that publishes and runs a workflow shaped
`webhook → loop(3 items, concurrency 1) → [transform] → after`, then asserts: three `b1#i` rows
exist, `after` ran once, the execution SUCCEEDED, and the events include one `loop.completed`.
Follow the existing scenario files in `e2e/test/` for the seeding and polling helpers.

- [ ] **Step 3: Full gates**

```bash
pnpm test
```

Expected: every package green. **Not `pnpm -r test`.**

```bash
pnpm -r typecheck
```

Expected: exit 0.

```bash
pnpm --filter @xperiment/engine-core test:cov && pnpm --filter @xperiment/ir test:cov && pnpm --filter @xperiment/connectors test:cov && pnpm --filter @xperiment/orchestrator test:cov && pnpm --filter @xperiment/web test:cov
```

Expected: exit 0 on all five, no threshold failures.

```bash
pnpm --filter @xperiment/web e2e
```

Expected: PASS.

Three e2e scenario tests — the failure-rate alert, the closed-period invoice, and the seconds-cron
schedule — are known to fail intermittently under full-suite load for reasons unrelated to this
slice; they are tracked separately. If they fail, re-run `pnpm --filter @xperiment/e2e test` alone to
confirm they pass in isolation before investigating.

- [ ] **Step 4: Commit**

```bash
git add README.md e2e
git commit -m "docs: document loops and error paths, add the loop scenario"
```

---

## Self-Review

**1. Spec coverage.**

| Spec section | Task |
|---|---|
| §2 `settings.onError`, `metadata.onError`, implicit `error` port, readiness resolution | 1 |
| §2 `nodeCompleted` loses its FAILED branch; `succeededOutputs` widened | 2 |
| §3 `core.loop`, ports, `maxIterations` fails, `scope` marker | 3 |
| §3 `expandLoops`, instance and join ids, no migration, N = 0 | 3 (connector picks `done`) and 4 (no join emitted) |
| §3 concurrency at dispatch | 6 |
| §3 iteration context | 5 |
| §3 a failing iteration follows the node's own policy | 1 — no loop-specific rule exists, which is the requirement |
| §4 `done` carries counts only | 3 and 8 (documented limitation) |
| §5 five validation findings | 3 |
| §6 canvas container, scope on drop, error handle, timeline grouping | 7 |
| §7 testing, both break-it checks | 1 Step 7, 6 Step 5 |

**Two gaps found and closed inline.** (a) The spec never said which port `core.loop` selects; an
empty loop only reaches its `done` edges if the connector returns `done`, so Task 3 makes that
explicit and Task 4's expansion needs no empty-loop branch at all. (b) `packages/expressions`
restricts expression roots to `trigger|nodes|execution`, so `loop.item` would have parsed and then
failed to resolve; Task 5 Step 5 adds the root. Neither was in the spec.

**One risk stated rather than hidden:** the loop node's output carries the resolved items array, so
a list too large for `PAYLOAD_CAP_BYTES` fails the loop node. That is the same rule every other node
lives under, the failure is visible, and it is routable down an error port — but it does mean the
practical iteration ceiling is the payload cap, not `maxIterations`. Documented in Task 8.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Task 7's steps 3
and 4 describe canvas work against components the plan does not quote, because they are the one area
where the existing file layout has to be read first; each names the exact file and the exact
behaviour, and its tests are written first in Step 1. Task 5 Step 1 and Task 6 Step 1 ask for helper
extensions in `apps/orchestrator/test/helpers.ts` and say exactly what they must produce.

**3. Type consistency.**

- `errorRouting(ir, nodeId): { port: string } | null` is defined in Task 1 and used only there.
- `expandLoops(ir, iterationCounts: Record<string, number>)` matches `loadIterationCounts`'s return
  type in Task 5.
- `instanceId` / `parseInstanceId` / `joinId` / `isJoinId` are defined in Task 4 and consumed in
  Tasks 5, 6 and 7 with those exact names.
- `nodeOutputs` replaces `succeededOutputs` in Task 2 and is consumed in Task 5's
  `loadIterationCounts` and the worker.
- `buildContext(executionId, triggerBody, outputs, loop?)` gains its fourth parameter in Task 5,
  and `ExpressionContext.loop` is added in the same step.
- `core.loop` output `{ items, count }` is written in Task 3 and read in Task 5 by both
  `loadIterationCounts` (`.count`) and the worker's loop frame (`.items`).
