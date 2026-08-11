/**
 * Decides WHAT run history to write, without writing any of it.
 *
 * Split from the writer on purpose: the interesting decisions here — where a run lands
 * in time, which node carries the failure, how long a run took — are the ones most
 * likely to be wrong, and they are all testable without a database.
 */

/** Jakarta is UTC+7 with no DST, so a fixed offset is exact rather than an approximation. */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A shop's runs cluster in its working day; a uniform spread reads as machine output. */
const FIRST_HOUR_WIB = 7;
const LAST_HOUR_WIB = 21;

const MIN_DURATION_MS = 320;
const MAX_DURATION_MS = 5_200;

/** A run still RUNNING is pinned to the last few minutes. One that has been RUNNING for
 *  three weeks is a stuck execution, not a demo — and it would teach an operator the
 *  wrong thing about what the status means. */
const RUNNING_WINDOW_MS = 5 * 60 * 1000;

export interface SeedWorkflowShape {
  slug: string;
  nodeIds: string[];
  weight: number;
}

export interface PlannedRun {
  workflowSlug: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  /** Parallel to the workflow's nodeIds. */
  nodeStatuses: string[];
  durationMs: number;
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * Not `Math.random()`: two people running `xperiment seed` and comparing notes should be
 * looking at the same demo, and a screenshot in a bug report should be reproducible.
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which node carries the outcome.
 *
 * Everything upstream of the interesting node succeeded — that is what a real run looks
 * like, and it is what makes the timeline worth opening. A demo whose nodes are all the
 * same colour shows an operator nothing about reading one.
 */
export function nodeStatusesFor(executionStatus: string, nodeCount: number): string[] {
  if (nodeCount <= 0) return [];
  const succeeded = (n: number): string[] => Array.from({ length: n }, () => 'SUCCEEDED');
  switch (executionStatus) {
    case 'SUCCEEDED':
      return succeeded(nodeCount);
    case 'FAILED':
    case 'TIMED_OUT':
      return [...succeeded(nodeCount - 1), 'FAILED'];
    case 'RUNNING':
      return [...succeeded(nodeCount - 1), 'RUNNING'];
    case 'CANCELED':
      return [...succeeded(nodeCount - 1), 'CANCELED'];
    default:
      return Array.from({ length: nodeCount }, () => 'PENDING');
  }
}

/** Place a run inside the working day `daysAgo` days back, in Jakarta local time. */
function startOfRun(nowMs: number, daysAgo: number, fraction: number): number {
  const wibDayStart = Math.floor((nowMs + WIB_OFFSET_MS) / DAY_MS) * DAY_MS - daysAgo * DAY_MS;
  const windowMs = (LAST_HOUR_WIB - FIRST_HOUR_WIB) * 60 * 60 * 1000;
  const wib = wibDayStart + FIRST_HOUR_WIB * 60 * 60 * 1000 + Math.floor(fraction * windowMs);
  return wib - WIB_OFFSET_MS;
}

export interface PlanRunsArgs {
  workflows: readonly SeedWorkflowShape[];
  statusMix: readonly { status: string; weight: number }[];
  count: number;
  days: number;
  nowMs: number;
  seed?: number;
}

/**
 * Build the run history, newest last.
 *
 * Nothing is ever placed in the future: the working-day window means today's slot can sit
 * hours ahead of the actual clock, and a run that completed tomorrow is the kind of detail
 * that makes a demo look broken to exactly the person you are demoing to.
 */
export function planRuns(args: PlanRunsArgs): PlannedRun[] {
  const rng = makeRng(args.seed ?? 0x716c6970);
  const totalWorkflowWeight = args.workflows.reduce((sum, w) => sum + w.weight, 0);
  const totalStatusWeight = args.statusMix.reduce((sum, s) => sum + s.weight, 0);
  if (args.workflows.length === 0 || totalWorkflowWeight <= 0 || totalStatusWeight <= 0) return [];

  const runs: PlannedRun[] = [];
  for (let i = 0; i < args.count; i += 1) {
    const workflow = pick(args.workflows, rng(), totalWorkflowWeight);
    const status = pick(args.statusMix, rng(), totalStatusWeight).status;
    const durationMs = MIN_DURATION_MS + Math.floor(rng() * (MAX_DURATION_MS - MIN_DURATION_MS));

    let startedMs: number;
    if (status === 'RUNNING') {
      startedMs = args.nowMs - Math.floor(rng() * RUNNING_WINDOW_MS);
    } else {
      const daysAgo = Math.floor(rng() * args.days);
      startedMs = Math.min(startOfRun(args.nowMs, daysAgo, rng()), args.nowMs - durationMs);
    }

    runs.push({
      workflowSlug: workflow.slug,
      status,
      startedAt: new Date(startedMs),
      completedAt: status === 'RUNNING' ? null : new Date(startedMs + durationMs),
      nodeStatuses: nodeStatusesFor(status, workflow.nodeIds.length),
      durationMs,
    });
  }
  return runs.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

function pick<T extends { weight: number }>(items: readonly T[], fraction: number, total: number): T {
  let target = Math.min(Math.max(fraction, 0), 0.999999) * total;
  for (const item of items) {
    target -= item.weight;
    if (target < 0) return item;
  }
  return items[items.length - 1] as T;
}
