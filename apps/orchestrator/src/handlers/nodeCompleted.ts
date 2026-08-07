import {
  appendEvent,
  casExecution,
  casNode,
  closeOpenWaits,
  enqueueCompletionCallback,
  ensureNodeAttempt,
  insertNodeAttempt,
  insertOutbox,
  latestNodeStates,
  recordExecutionUsage,
  withTx,
} from '@xperiment/db';
import {
  computeReadiness,
  expandLoops,
  instanceId,
  joinId,
  parseInstanceId,
  type NodeOutcome,
  type NodeStatus,
} from '@xperiment/engine-core';
import type { NodeCompletedPayload } from '@xperiment/queue';
import {
  buildExecutionUsage,
  loadExecutionContext,
  loadIterationCounts,
  TERMINAL_EXECUTION_STATUSES,
  type OrchestratorDeps,
} from '../deps.js';

export async function handleNodeCompleted(deps: OrchestratorDeps, payload: NodeCompletedPayload): Promise<void> {
  const ctx = await loadExecutionContext(deps.pool, payload.executionId);
  if (!ctx) {
    deps.log('node_completed.unknown_execution', { executionId: payload.executionId });
    return;
  }
  if (TERMINAL_EXECUTION_STATUSES.includes(ctx.execution.status)) {
    deps.log('node_completed.execution_terminal', { executionId: payload.executionId });
    return;
  }
  const { executionId, nodeId } = payload;

  if (payload.status === 'RETRY_SCHEDULED') {
    const nextAttempt = payload.attempt + 1;
    try {
      await withTx(deps.pool, async (client) => {
        await insertNodeAttempt(client, { executionId, nodeId, attempt: nextAttempt, status: 'QUEUED' });
        await appendEvent(client, {
          executionId,
          eventType: 'node.retry_scheduled',
          nodeId,
          payload: { attempt: nextAttempt, delayMs: payload.delayMs ?? 0 },
        });
        await insertOutbox(client, {
          eventType: 'node.task',
          payload: { executionId, nodeId, attempt: nextAttempt },
          delayMs: payload.delayMs ?? 0,
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        deps.log('node_completed.retry_duplicate', { executionId, nodeId, attempt: nextAttempt });
        return;
      }
      throw e;
    }
    return;
  }

  // A failure is no longer special-cased. It flows into the same readiness pass as a success
  // and only ends the execution when readiness says the failure was unhandled — an error edge
  // or an `onError: 'continue'` policy keeps the run alive. Readiness also propagates the
  // skips that this handler used to write by hand.
  await withTx(deps.pool, async (client) => {
    const states = await latestNodeStates(client, executionId);
    const counts = await loadIterationCounts(client, executionId, ctx.ir);
    // Loops are rewritten out of the graph here; the scheduler below never learns they exist.
    const graph = expandLoops(ctx.ir, counts);
    const outcomes: NodeOutcome[] = states.map((s) => ({
      nodeId: s.nodeId,
      status: s.status as NodeStatus,
      outputPort: s.outputPort,
    }));

    /**
     * A join has no inbound edges, so readiness will never schedule it. Seed it the moment
     * every instance of its loop is decided, which lets the loop's `done` edges fire.
     *
     * Returns true when it seeded anything.
     */
    const seedFinishedJoins = async (): Promise<boolean> => {
      let seededAny = false;
      for (const [loopId, count] of Object.entries(counts)) {
        if (count === 0) continue; // an empty loop fires `done` from the loop node itself
        const jid = joinId(loopId);
        if (outcomes.some((o) => o.nodeId === jid)) continue;
        const body = ctx.ir.nodes.filter((n) => n.scope?.loopId === loopId).map((n) => n.id);
        const wanted = body.flatMap((b) => Array.from({ length: count }, (_, i) => instanceId(b, i)));
        const decided = wanted.every((id) => {
          const o = outcomes.find((x) => x.nodeId === id);
          return o !== undefined && ['SUCCEEDED', 'SKIPPED', 'FAILED'].includes(o.status);
        });
        if (!decided) continue;
        const seeded = await ensureNodeAttempt(client, {
          executionId,
          nodeId: jid,
          attempt: 1,
          status: 'SUCCEEDED',
        });
        if (seeded) {
          await appendEvent(client, { executionId, eventType: 'loop.completed', nodeId: loopId, payload: { count } });
        }
        outcomes.push({ nodeId: jid, status: 'SUCCEEDED', outputPort: 'main' });
        seededAny = true;
      }
      return seededAny;
    };

    await seedFinishedJoins();
    let readiness = computeReadiness(graph, outcomes);

    // A skip decides a node but emits no node.completed, so nothing would re-enter this
    // handler. If the last undecided instance of a loop is decided by a skip — a core.if in
    // the body taking the branch that leads nowhere — the join must be seeded in THIS pass or
    // the execution hangs until the watchdog. Fold the skips in and try again; seeding one
    // join can decide the next, so iterate until nothing new is seeded. There are finitely
    // many loops, so this terminates.
    // Accumulated across passes: once a node is folded in as SKIPPED, a later readiness call
    // reports it as already decided rather than newly skipped, so the last pass alone does not
    // carry every id that still needs a row written.
    const toSkip = new Set<string>();
    for (;;) {
      for (const id of readiness.skipped) {
        toSkip.add(id);
        const existing = outcomes.find((o) => o.nodeId === id);
        if (existing) existing.status = 'SKIPPED';
        else outcomes.push({ nodeId: id, status: 'SKIPPED' });
      }
      if (!(await seedFinishedJoins())) break;
      readiness = computeReadiness(graph, outcomes);
    }

    // Loop instances have no row: the execution seeded only the authored nodes, because a
    // body node never runs under its authored id. Materialise on the way past, never ahead of
    // time — a row created for an iteration the throttle has not released would show in the
    // timeline as a node that is somehow already pending.
    // Built from what the DATABASE holds, not from `outcomes` — the passes above push
    // synthetic SKIPPED and join entries into `outcomes`, and treating those as existing rows
    // would skip the insert the CAS below needs.
    const known = new Set(states.map((s) => s.nodeId));
    const materialise = async (id: string): Promise<void> => {
      if (known.has(id)) return;
      await ensureNodeAttempt(client, { executionId, nodeId: id, attempt: 1, status: 'PENDING' });
      known.add(id);
    };

    for (const skippedId of toSkip) {
      await materialise(skippedId);
      const ok = await casNode(client, {
        executionId,
        nodeId: skippedId,
        attempt: 1,
        from: ['PENDING'],
        to: 'SKIPPED',
      });
      if (ok) await appendEvent(client, { executionId, eventType: 'node.skipped', nodeId: skippedId });
    }
    // Readiness marks every iteration ready at once; the limit belongs here, at dispatch.
    // A slot is held by any instance that is neither PENDING nor terminal.
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
    const starting = new Map<string, Set<number>>();

    // An unhandled failure is "decided", so a fan-in node downstream of it can read as ready
    // in the very pass that ends the run. Dispatching it would strand a QUEUED row forever:
    // the worker refuses any task belonging to a terminal execution.
    const dispatchable = readiness.terminal === 'FAILED' ? [] : readiness.ready;

    for (const readyId of dispatchable) {
      const parsed = parseInstanceId(readyId);
      const owner = parsed ? loopOf.get(parsed.nodeId) : undefined;
      if (owner !== undefined && parsed) {
        const started = starting.get(owner) ?? new Set<number>();
        // A second node of an iteration already under way costs nothing more; only a new
        // iteration spends budget. Charging it again would deadlock at concurrency 1.
        if (!started.has(parsed.iteration)) {
          const left = budget.get(owner) ?? 0;
          if (left <= 0) continue; // stays PENDING; the next completion picks it up
          budget.set(owner, left - 1);
          started.add(parsed.iteration);
          starting.set(owner, started);
        }
      }
      await materialise(readyId);
      const claimed = await casNode(client, {
        executionId,
        nodeId: readyId,
        attempt: 1,
        from: ['PENDING'],
        to: 'READY',
      });
      if (!claimed) continue; // another completion already queued it
      await appendEvent(client, { executionId, eventType: 'node.ready', nodeId: readyId });
      await casNode(client, { executionId, nodeId: readyId, attempt: 1, from: ['READY'], to: 'QUEUED' });
      await appendEvent(client, { executionId, eventType: 'node.queued', nodeId: readyId });
      await insertOutbox(client, { eventType: 'node.task', payload: { executionId, nodeId: readyId, attempt: 1 } });
    }

    if (readiness.terminal === 'SUCCEEDED') {
      const done = await casExecution(client, { executionId, from: ['RUNNING'], to: 'SUCCEEDED', completedAt: true });
      if (done) {
        await appendEvent(client, { executionId, eventType: 'execution.succeeded' });
        await enqueueCompletionCallback(client, { workflowId: ctx.execution.workflowId, executionId });
        await recordExecutionUsage(client, buildExecutionUsage(ctx.execution, states, 'SUCCEEDED'));
      }
    } else if (readiness.terminal === 'FAILED') {
      const done = await casExecution(client, {
        executionId,
        from: ['RUNNING'],
        to: 'FAILED',
        completedAt: true,
        // Name the node when this completion is the failing one; a fan-in may finalize on a
        // failure reported earlier.
        errorSummary: payload.status === 'FAILED' ? `Node '${nodeId}' failed` : 'A node failed',
      });
      if (done) {
        // Readiness only skips a node whose inbound edges are all inactive, so one sitting
        // behind a still-RUNNING sibling stays PENDING. Sweep the remainder, as the deleted
        // FAILED short-circuit used to, or a finished execution keeps nodes at PENDING
        // forever.
        for (const s of await latestNodeStates(client, executionId)) {
          if (s.status !== 'PENDING') continue;
          const swept = await casNode(client, {
            executionId,
            nodeId: s.nodeId,
            attempt: s.attempt,
            from: ['PENDING'],
            to: 'SKIPPED',
          });
          if (swept) await appendEvent(client, { executionId, eventType: 'node.skipped', nodeId: s.nodeId });
        }
        await closeOpenWaits(client, executionId);
        await appendEvent(client, { executionId, eventType: 'execution.failed' });
        await enqueueCompletionCallback(client, { workflowId: ctx.execution.workflowId, executionId });
        await recordExecutionUsage(client, buildExecutionUsage(ctx.execution, states, 'FAILED'));
      }
    }
  });
}
