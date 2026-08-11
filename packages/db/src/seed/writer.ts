import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SecretVault } from '../crypto/vault.js';
import { createConnection } from '../repos/connections.js';
import { setWorkspacePlan } from '../repos/entitlements.js';
import { insertUsageEvents, type UsageEventInput } from '../repos/usage.js';
import { createVersion, createWorkflow, updateDraft } from '../repos/workflows.js';
import { withTx } from '../tx.js';
import { planRuns, type PlannedRun } from './plan.js';
import { SEED_CONNECTIONS, SEED_FAILURES, SEED_STATUS_MIX, SEED_WORKFLOWS, type SeedWorkflow } from './scenario.js';

/**
 * Writes the demo workspace.
 *
 * Deliberately does NOT go through `createExecutionWithTrigger`. That function consumes
 * quota, can only produce a `CREATED` row, and inserts two `task_outbox` rows per call —
 * so seeding three hundred executions through it would burn three hundred units of the
 * workspace's monthly cap AND actually run three hundred workflows against whatever the
 * connections point at, the moment any developer has the stack running. Run history is
 * written with direct SQL, and no outbox row is ever inserted.
 */

const RUN_BATCH = 50;
const DEFAULT_WORKSPACE_NAME = 'Toko Demo (FAKE)';
const DEFAULT_RUNS = 240;
const DEFAULT_DAYS = 30;

export interface SeedDeps {
  pool: pg.Pool;
  /**
   * Must be the same hash the publish path computes.
   *
   * Injected rather than imported so `@xperiment/db` — which every service loads — does not
   * grow a dependency on `@xperiment/ir` for the sake of a demo command.
   */
  hashDefinition: (definition: unknown) => string;
  /** Seals connection payloads. Omit it and no connections are written at all: a
   *  plaintext row would look healthy in the list and fail GCM auth on the first run. */
  vault?: SecretVault | undefined;
}

export interface SeedArgs {
  workspaceName?: string;
  runs?: number;
  days?: number;
  nowMs?: number;
  seed?: number;
}

export interface SeedSummary {
  workspaceId: string;
  workspaceName: string;
  workflows: number;
  connections: number;
  executions: number;
  usageEvents: number;
}

export class SeedConflictError extends Error {}

/** Build a multi-row VALUES list, appending to a shared parameter array. */
function valuesSql(rows: readonly unknown[][], params: unknown[]): string {
  return rows
    .map((row) => {
      const base = params.length;
      params.push(...row);
      return `(${row.map((_, i) => `$${base + i + 1}`).join(',')})`;
    })
    .join(',');
}

function nodeIdsOf(wf: SeedWorkflow): string[] {
  const nodes = (wf.definition['nodes'] as { id: string }[] | undefined) ?? [];
  return nodes.map((n) => n.id);
}

function parametersOf(wf: SeedWorkflow, nodeId: string): unknown {
  const nodes = (wf.definition['nodes'] as { id: string; parameters?: unknown }[] | undefined) ?? [];
  return nodes.find((n) => n.id === nodeId)?.parameters ?? null;
}

export async function seedDemoWorkspace(deps: SeedDeps, args: SeedArgs = {}): Promise<SeedSummary> {
  const workspaceName = args.workspaceName ?? DEFAULT_WORKSPACE_NAME;
  const runs = args.runs ?? DEFAULT_RUNS;
  const days = args.days ?? DEFAULT_DAYS;
  const nowMs = args.nowMs ?? Date.now();

  // Refuse rather than pile a second demo on top of the first. There is no --reset here
  // on purpose: a cascade delete across two dozen tables is exactly the kind of thing
  // that silently half-succeeds, and on a development stack a re-migrate is the honest
  // reset.
  const existing = await deps.pool.query(`SELECT id FROM workspaces WHERE name = $1`, [workspaceName]);
  if (existing.rowCount) {
    throw new SeedConflictError(
      `A workspace named "${workspaceName}" already exists. Pass --name to seed a second one, or drop and re-migrate the database.`,
    );
  }

  // workspaces.id has no default, unlike every other table here.
  const created = await deps.pool.query(`INSERT INTO workspaces (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [
    workspaceName,
  ]);
  const workspaceId = (created.rows[0] as { id: string }).id;

  // A demo that hits a quota wall halfway through the tour is worse than no demo.
  await setWorkspacePlan(deps.pool, { workspaceId, planCode: 'team' });

  const published = new Map<string, { workflowId: string; versionId: string }>();
  for (const wf of SEED_WORKFLOWS) {
    const row = await createWorkflow(deps.pool, { workspaceId, name: wf.name });
    await updateDraft(deps.pool, { workflowId: row.id, definition: wf.definition, expectedRevision: 1 });
    const version = await createVersion(deps.pool, {
      workflowId: row.id,
      definition: wf.definition,
      hash: deps.hashDefinition(wf.definition),
    });
    await deps.pool.query(`UPDATE workflows SET active = true WHERE id = $1`, [row.id]);
    published.set(wf.slug, { workflowId: row.id, versionId: version.id });
  }

  let connections = 0;
  if (deps.vault) {
    for (const conn of SEED_CONNECTIONS) {
      const sealed = await deps.vault.encrypt(workspaceId, JSON.stringify(conn.payload));
      await createConnection(deps.pool, {
        workspaceId,
        connectorKey: conn.connectorKey,
        name: conn.name,
        encryptedPayload: sealed.blob,
        encVersion: sealed.encVersion,
      });
      connections += 1;
    }
  }

  const shapes = SEED_WORKFLOWS.map((wf) => ({ slug: wf.slug, nodeIds: nodeIdsOf(wf), weight: wf.weight }));
  const planned = planRuns({
    workflows: shapes,
    statusMix: SEED_STATUS_MIX,
    count: runs,
    days,
    nowMs,
    ...(args.seed === undefined ? {} : { seed: args.seed }),
  });

  const bySlug = new Map(SEED_WORKFLOWS.map((wf) => [wf.slug, wf]));
  let executions = 0;
  let usageEvents = 0;
  for (let i = 0; i < planned.length; i += RUN_BATCH) {
    const batch = planned.slice(i, i + RUN_BATCH);
    const written = await withTx(deps.pool, (client) =>
      writeRunBatch(client, { workspaceId, batch, bySlug, published }),
    );
    executions += written.executions;
    usageEvents += written.usageEvents;
  }

  return { workspaceId, workspaceName, workflows: published.size, connections, executions, usageEvents };
}

interface BatchArgs {
  workspaceId: string;
  batch: readonly PlannedRun[];
  bySlug: Map<string, SeedWorkflow>;
  published: Map<string, { workflowId: string; versionId: string }>;
}

async function writeRunBatch(
  client: pg.PoolClient,
  args: BatchArgs,
): Promise<{ executions: number; usageEvents: number }> {
  const execRows: unknown[][] = [];
  const nodeRows: unknown[][] = [];
  const eventRows: unknown[][] = [];
  const usage: UsageEventInput[] = [];

  for (const [index, run] of args.batch.entries()) {
    const wf = args.bySlug.get(run.workflowSlug);
    const target = args.published.get(run.workflowSlug);
    if (!wf || !target) continue;

    const executionId = randomUUID();
    const terminal = run.completedAt !== null;
    // A stable pick, so re-seeding with the same seed tells the same story.
    const failure = SEED_FAILURES[index % SEED_FAILURES.length] ?? SEED_FAILURES[0]!;
    const failed = run.status === 'FAILED' || run.status === 'TIMED_OUT';

    execRows.push([
      executionId,
      args.workspaceId,
      target.workflowId,
      target.versionId,
      run.status,
      'production',
      run.startedAt,
      run.completedAt,
      run.startedAt,
      failed ? failure.message : null,
    ]);

    const ids = nodeIdsOf(wf);
    const slice = run.durationMs / Math.max(ids.length, 1);
    for (const [n, nodeId] of ids.entries()) {
      const status = run.nodeStatuses[n] ?? 'PENDING';
      const nodeStart = new Date(run.startedAt.getTime() + Math.round(n * slice));
      const nodeEnd = new Date(run.startedAt.getTime() + Math.round((n + 1) * slice));
      const settled = status === 'SUCCEEDED' || status === 'FAILED';
      // A trigger has no input and its OUTPUT is the body — that is the value every
      // downstream `{{ trigger.body… }}` reads, so putting the body on the input side
      // would show the operator a payload the expressions cannot actually see.
      const isTrigger = n === 0;
      const output =
        status !== 'SUCCEEDED' ? null : isTrigger ? wf.sample.trigger : (wf.sample.outputs[nodeId] ?? null);
      const input = isTrigger ? null : parametersOf(wf, nodeId);

      nodeRows.push([
        args.workspaceId,
        executionId,
        nodeId,
        status,
        1,
        input === null ? null : JSON.stringify(input),
        output === null ? null : JSON.stringify(output),
        status === 'SUCCEEDED' ? 'main' : null,
        status === 'FAILED' ? JSON.stringify({ code: failure.code, message: failure.message }) : null,
        status === 'PENDING' ? null : nodeStart,
        settled ? nodeEnd : null,
      ]);

      if (status === 'PENDING') continue;
      eventRows.push([args.workspaceId, executionId, 'node.started', nodeId, null, nodeStart]);
      if (status === 'SUCCEEDED') {
        eventRows.push([args.workspaceId, executionId, 'node.succeeded', nodeId, null, nodeEnd]);
      } else if (status === 'FAILED') {
        eventRows.push([
          args.workspaceId,
          executionId,
          'node.failed',
          nodeId,
          JSON.stringify({ code: failure.code }),
          nodeEnd,
        ]);
      }
    }

    eventRows.push([args.workspaceId, executionId, 'execution.created', null, null, run.startedAt]);
    if (terminal) {
      const type = failed ? 'execution.failed' : run.status === 'CANCELED' ? 'execution.created' : 'execution.succeeded';
      eventRows.push([args.workspaceId, executionId, type, null, null, run.completedAt]);
    }

    // metadata.status is the exact key the usage dashboard filters on; without it the
    // succeeded/failed split renders as zero and the chart looks broken rather than empty.
    const base = {
      workspaceId: args.workspaceId,
      workflowId: target.workflowId,
      executionId,
      occurredAt: run.completedAt ?? run.startedAt,
    };
    usage.push({ ...base, metric: 'execution', quantity: 1, metadata: { status: run.status } });
    usage.push({ ...base, metric: 'node', quantity: ids.length });
    usage.push({ ...base, metric: 'compute_ms', quantity: run.durationMs });
  }

  if (execRows.length === 0) return { executions: 0, usageEvents: 0 };

  const execParams: unknown[] = [];
  await client.query(
    `INSERT INTO executions
       (id, workspace_id, workflow_id, workflow_version_id, status, mode, started_at, completed_at, created_at, error_summary)
     VALUES ${valuesSql(execRows, execParams)}`,
    execParams,
  );

  const nodeParams: unknown[] = [];
  await client.query(
    `INSERT INTO execution_nodes
       (workspace_id, execution_id, node_id, status, attempt, input_json, output_json, output_port, error_json, started_at, completed_at)
     VALUES ${valuesSql(nodeRows, nodeParams)}`,
    nodeParams,
  );

  const eventParams: unknown[] = [];
  await client.query(
    `INSERT INTO execution_events (workspace_id, execution_id, event_type, node_id, payload_json, created_at)
     VALUES ${valuesSql(eventRows, eventParams)}`,
    eventParams,
  );

  await insertUsageEvents(client, usage);
  return { executions: execRows.length, usageEvents: usage.length };
}
