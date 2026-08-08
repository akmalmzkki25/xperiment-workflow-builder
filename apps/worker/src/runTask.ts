import { randomBytes } from 'node:crypto';
import type { ConnectorRegistry, SuspendSpec } from '@xperiment/connectors';
import {
  appendAuditEvent,
  appendEvent,
  casNode,
  getConnectionWithPayload,
  getExecutionDetail,
  getTriggerPayload,
  getVersion,
  insertOutbox,
  openWait,
  nodeOutputs,
  withTx,
  type SecretVault,
} from '@xperiment/db';
import {
  buildContext,
  parseInstanceId,
  computeBackoffMs,
  normalizedError,
  resolveRetryPolicy,
  shouldRetry,
  type NormalizedError,
  type ResolvedRetryPolicy,
} from '@xperiment/engine-core';
import { resolveTemplate } from '@xperiment/expressions';
import { workflowIrSchema, type IRNode, type WorkflowIR } from '@xperiment/ir';
import type { NodeTaskPayload } from '@xperiment/queue';
import type pg from 'pg';
import { classifyError } from './classify.js';

const TERMINAL_EXECUTION_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'];
const DEFAULT_NODE_TIMEOUT_MS = 30000;
const EVENT_WAIT_MAX_TTL_MS = 2_592_000_000; // 30 days — hard ceiling for un-timed event waits

export interface WorkerDeps {
  pool: pg.Pool;
  registry: ConnectorRegistry;
  workerId: string;
  credentialsVault: SecretVault;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Resolves and decrypts the node's connection payload; throws NormalizedError-shaped info via recordFailure at the call site.
 *
 * The workspace id is required, not optional. Before envelope encryption this call
 * omitted it and would resolve any connection UUID in the database, so a published IR
 * could reach another tenant's credential — publish-time validation was the only guard.
 * Decryption now needs the workspace anyway, so the filter cannot be dropped again.
 */
async function resolveConnection(
  deps: WorkerDeps,
  node: IRNode,
  ctx: { workspaceId: string; executionId: string; workflowId: string },
): Promise<{ ok: true; connection: unknown } | { ok: false; error: NormalizedError }> {
  const def = deps.registry.get(node.type);
  if (!def?.requiresConnection) return { ok: true, connection: undefined };
  if (!node.connectionRef) {
    return {
      ok: false,
      error: normalizedError('connection_required', `Node requires a '${def.requiresConnection}' connection`, false),
    };
  }
  const row = await getConnectionWithPayload(deps.pool, node.connectionRef, ctx.workspaceId);
  if (!row || row.connectorKey !== def.requiresConnection) {
    return { ok: false, error: normalizedError('connection_not_found', 'Referenced connection not found', false) };
  }
  let connection: unknown;
  try {
    connection = JSON.parse(
      await deps.credentialsVault.decrypt(ctx.workspaceId, {
        blob: row.encryptedPayload,
        encVersion: row.encVersion,
      }),
    );
  } catch {
    // A failed decrypt is deliberately not audited as a read-use: nothing was read.
    // This is also the fail-closed path when KMS is unreachable with a cold cache.
    return { ok: false, error: normalizedError('connection_invalid', 'Stored connection could not be decrypted', false) };
  }
  // SEC-009: one row per node that actually consumed a credential. Emitted on the pool —
  // nothing was mutated — with a system actor, since no user is present.
  await appendAuditEvent(deps.pool, {
    workspaceId: ctx.workspaceId,
    actorKind: 'system',
    action: 'credential.read_use',
    targetType: 'connection',
    targetId: row.id,
    metadata: {
      executionId: ctx.executionId,
      nodeId: node.id,
      workflowId: ctx.workflowId,
      connectorKey: row.connectorKey,
    },
  });
  return { ok: true, connection };
}

export async function runNodeTask(deps: WorkerDeps, payload: NodeTaskPayload): Promise<void> {
  const { executionId, nodeId, attempt } = payload;

  const detail = await getExecutionDetail(deps.pool, executionId);
  if (!detail) {
    deps.log('run_task.unknown_execution', { executionId });
    return;
  }
  if (TERMINAL_EXECUTION_STATUSES.includes(detail.execution.status)) {
    deps.log('run_task.execution_terminal', { executionId, nodeId });
    return;
  }
  const version = await getVersion(deps.pool, detail.execution.workflowVersionId);
  if (!version) {
    deps.log('run_task.missing_version', { executionId });
    return;
  }
  const ir = workflowIrSchema.parse(version.definition) as WorkflowIR;
  // A loop instance is a copy of an authored node: `b1#3` carries `b1`'s type, parameters,
  // timeout and retry policy. Only the IR lookup resolves the authored id; everywhere else
  // nodeId is a database key and must stay the instance id.
  const instance = parseInstanceId(nodeId);
  const node = ir.nodes.find((n) => n.id === (instance?.nodeId ?? nodeId));
  if (!node) {
    deps.log('run_task.unknown_node', { executionId, nodeId });
    return;
  }

  const claimed = await casNode(deps.pool, {
    executionId,
    nodeId,
    attempt,
    from: ['QUEUED'],
    to: 'RUNNING',
    patch: { startedAt: true, workerId: deps.workerId },
  });
  if (!claimed) {
    deps.log('run_task.duplicate_delivery', { executionId, nodeId, attempt });
    return;
  }
  await appendEvent(deps.pool, { executionId, eventType: 'node.started', nodeId, payload: { attempt } });

  const policy = resolveRetryPolicy(node.settings?.retry);
  let resolvedParams: unknown;
  try {
    const connectionResult = await resolveConnection(deps, node, {
      workspaceId: detail.execution.workspaceId,
      executionId,
      workflowId: detail.execution.workflowId,
    });
    if (!connectionResult.ok) {
      await recordFailure(deps, {
        executionId,
        nodeId,
        attempt,
        normalized: connectionResult.error,
        policy,
        resolvedParams: null,
      });
      return;
    }
    const triggerBody = await getTriggerPayload(deps.pool, executionId);
    const outputs = await nodeOutputs(deps.pool, executionId);
    // The item this iteration is for. It comes from the loop node's own recorded output, so
    // no second read and no duplication beyond what the loop already stored.
    let loopFrame: { index: number; item: unknown } | undefined;
    if (instance && node.scope) {
      const items = (outputs[node.scope.loopId] as { items?: unknown } | undefined)?.items;
      if (Array.isArray(items)) loopFrame = { index: instance.iteration, item: items[instance.iteration] };
    }
    // The one and only wall-clock read in the expression path. Fixing it here means
    // every {{ now() }} in this node's parameters agrees, and a replay can pin it.
    const evaluatedAt = Date.now();
    const ctx = buildContext(executionId, triggerBody, outputs, {
      now: evaluatedAt,
      ...(loopFrame ? { loop: loopFrame } : {}),
    });
    resolvedParams = resolveTemplate(node.parameters, ctx);
    const result = await executeNode(deps, {
      node,
      resolvedParams,
      triggerBody,
      executionId,
      attempt,
      connection: connectionResult.connection,
    });
    if (result.suspend) {
      await suspendNode(deps, { executionId, nodeId, attempt, resolvedParams, suspend: result.suspend });
      return;
    }
    await withTx(deps.pool, async (client) => {
      const written = await casNode(client, {
        executionId,
        nodeId,
        attempt,
        from: ['RUNNING'],
        to: 'SUCCEEDED',
        patch: {
          inputJson: resolvedParams,
          outputJson: result.output ?? null,
          outputPort: result.outputPort ?? 'main',
          completedAt: true,
        },
      });
      if (!written) return; // lost the row (e.g. watchdog) — do not emit completion
      await appendEvent(client, { executionId, eventType: 'node.succeeded', nodeId, payload: { attempt } });
      await insertOutbox(client, {
        eventType: 'node.completed',
        payload: { executionId, nodeId, attempt, status: 'SUCCEEDED', outputPort: result.outputPort ?? 'main' },
      });
    });
  } catch (err) {
    const normalized = classifyError(err, policy);
    await recordFailure(deps, { executionId, nodeId, attempt, normalized, policy, resolvedParams });
  }
}

/**
 * Durably suspends a node: CAS RUNNING → WAITING and record the wait. No
 * `node.completed` is emitted — resume (approval/event/timer) drives that later.
 * The worker owns absolute time; the connector supplied a relative duration.
 */
async function suspendNode(
  deps: WorkerDeps,
  args: { executionId: string; nodeId: string; attempt: number; resolvedParams: unknown; suspend: SuspendSpec },
): Promise<void> {
  const { executionId, nodeId, attempt, suspend } = args;
  const now = Date.now();
  await withTx(deps.pool, async (client) => {
    const written = await casNode(client, {
      executionId,
      nodeId,
      attempt,
      from: ['RUNNING'],
      to: 'WAITING',
      patch: { inputJson: args.resolvedParams ?? null },
    });
    if (!written) return; // lost the row (e.g. watchdog) — do not open a wait
    if (suspend.kind === 'timer') {
      await openWait(client, {
        executionId,
        nodeId,
        attempt,
        kind: 'timer',
        resumeAt: new Date(now + suspend.delayMs),
      });
    } else if (suspend.kind === 'event') {
      // Cap even un-timed event waits so an execution can't stay suspended (with a
      // live resume token) forever if its callback never arrives.
      const ttlMs = suspend.ttlMs ?? EVENT_WAIT_MAX_TTL_MS;
      await openWait(client, {
        executionId,
        nodeId,
        attempt,
        kind: 'event',
        resumeToken: randomBytes(24).toString('base64url'),
        expiresAt: new Date(now + ttlMs),
      });
    } else {
      await openWait(client, {
        executionId,
        nodeId,
        attempt,
        kind: 'approval',
        resumeToken: randomBytes(24).toString('base64url'),
        expiresAt: new Date(now + suspend.ttlMs),
        fallback: suspend.fallback,
        message: suspend.message,
      });
    }
    await appendEvent(client, { executionId, eventType: 'node.waiting', nodeId, payload: { attempt, kind: suspend.kind } });
  });
}

async function executeNode(
  deps: WorkerDeps,
  args: {
    node: IRNode;
    resolvedParams: unknown;
    triggerBody: unknown;
    executionId: string;
    attempt: number;
    connection?: unknown;
  },
): Promise<{ output?: unknown; outputPort?: string; suspend?: SuspendSpec }> {
  const { node } = args;
  const def = deps.registry.get(node.type);
  if (!def) throw new Error(`No connector registered for node type '${node.type}'`);
  const timeoutMs = node.settings?.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
  return def.run({
    executionId: args.executionId,
    nodeId: node.id,
    attempt: args.attempt,
    parameters: args.resolvedParams,
    triggerBody: args.triggerBody,
    connection: args.connection,
    signal: AbortSignal.timeout(timeoutMs),
    log: deps.log,
  });
}

async function recordFailure(
  deps: WorkerDeps,
  args: {
    executionId: string;
    nodeId: string;
    attempt: number;
    normalized: NormalizedError;
    policy: ResolvedRetryPolicy;
    resolvedParams: unknown;
  },
): Promise<void> {
  const { executionId, nodeId, attempt, normalized, policy } = args;
  const retrying = shouldRetry(normalized, attempt, policy);
  const to = retrying ? 'RETRY_SCHEDULED' : 'FAILED';
  const delayMs = retrying ? computeBackoffMs(attempt, policy) : undefined;

  await withTx(deps.pool, async (client) => {
    const written = await casNode(client, {
      executionId,
      nodeId,
      attempt,
      from: ['RUNNING'],
      to,
      patch: {
        inputJson: args.resolvedParams ?? null,
        errorJson: normalized,
        completedAt: true,
      },
    });
    if (!written) return;
    await appendEvent(client, {
      executionId,
      eventType: retrying ? 'node.retrying' : 'node.failed',
      nodeId,
      payload: { attempt, error: normalized, ...(delayMs !== undefined ? { delayMs } : {}) },
    });
    await insertOutbox(client, {
      eventType: 'node.completed',
      payload: {
        executionId,
        nodeId,
        attempt,
        status: to,
        ...(delayMs !== undefined ? { delayMs } : {}),
      },
    });
  });
}
