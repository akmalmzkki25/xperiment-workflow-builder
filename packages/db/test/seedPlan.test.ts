import { describe, expect, test } from 'vitest';
import { makeRng, nodeStatusesFor, planRuns, type SeedWorkflowShape } from '../src/seed/plan.js';

const NOW = Date.parse('2026-08-11T09:00:00.000Z');

const WORKFLOWS: SeedWorkflowShape[] = [
  { slug: 'a', nodeIds: ['t', 'x'], weight: 5 },
  { slug: 'b', nodeIds: ['t', 'y', 'z'], weight: 2 },
];

const MIX = [
  { status: 'SUCCEEDED', weight: 80 },
  { status: 'FAILED', weight: 12 },
  { status: 'RUNNING', weight: 5 },
  { status: 'CANCELED', weight: 3 },
];

function plan(overrides: Partial<Parameters<typeof planRuns>[0]> = {}) {
  return planRuns({ workflows: WORKFLOWS, statusMix: MIX, count: 200, days: 30, nowMs: NOW, ...overrides });
}

describe('makeRng', () => {
  test('is deterministic, so two people see the same demo', () => {
    const a = Array.from({ length: 8 }, makeRng(7));
    expect(Array.from({ length: 8 }, makeRng(7))).toEqual(a);
  });

  test('a different seed gives a different stream', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });

  test('stays inside [0, 1)', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 500; i += 1) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('nodeStatusesFor', () => {
  test('everything upstream of the failure succeeded', () => {
    // A run whose nodes are all the same colour teaches an operator nothing about
    // reading a timeline.
    expect(nodeStatusesFor('FAILED', 3)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'FAILED']);
  });

  test('a single-node failure is just the failure', () => {
    expect(nodeStatusesFor('FAILED', 1)).toEqual(['FAILED']);
  });

  test('a succeeded run is green throughout', () => {
    expect(nodeStatusesFor('SUCCEEDED', 2)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
  });

  test('an unknown status never fabricates a success', () => {
    expect(nodeStatusesFor('QUEUED', 2)).toEqual(['PENDING', 'PENDING']);
  });

  test('a zero-node workflow yields nothing rather than throwing', () => {
    expect(nodeStatusesFor('SUCCEEDED', 0)).toEqual([]);
  });
});

describe('planRuns', () => {
  test('no run is ever dated in the future', () => {
    // The working-day window can put today's slot hours past the actual clock, and a run
    // that completed tomorrow is exactly what a viewer notices first.
    for (const run of plan()) {
      expect(run.startedAt.getTime()).toBeLessThanOrEqual(NOW);
      if (run.completedAt) expect(run.completedAt.getTime()).toBeLessThanOrEqual(NOW);
    }
  });

  test('a RUNNING run started minutes ago, not weeks ago', () => {
    const running = plan().filter((r) => r.status === 'RUNNING');
    expect(running.length).toBeGreaterThan(0);
    for (const run of running) {
      expect(NOW - run.startedAt.getTime()).toBeLessThanOrEqual(5 * 60 * 1000);
      expect(run.completedAt).toBeNull();
    }
  });

  test('every terminal run has a completion after its start', () => {
    for (const run of plan().filter((r) => r.status !== 'RUNNING')) {
      expect(run.completedAt).not.toBeNull();
      expect(run.completedAt!.getTime()).toBeGreaterThan(run.startedAt.getTime());
    }
  });

  test('runs come out oldest first, which is the order they are written', () => {
    const runs = plan();
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]!.startedAt.getTime()).toBeGreaterThanOrEqual(runs[i - 1]!.startedAt.getTime());
    }
  });

  test('history stays inside the requested window', () => {
    const runs = plan({ days: 7 });
    const oldest = Math.min(...runs.map((r) => r.startedAt.getTime()));
    expect(NOW - oldest).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  test('both workflows and several statuses actually appear', () => {
    const runs = plan();
    expect(new Set(runs.map((r) => r.workflowSlug))).toEqual(new Set(['a', 'b']));
    expect(new Set(runs.map((r) => r.status)).size).toBeGreaterThanOrEqual(3);
  });

  test('node statuses line up with the workflow that ran', () => {
    const byslug = new Map(WORKFLOWS.map((w) => [w.slug, w.nodeIds.length]));
    for (const run of plan()) {
      expect(run.nodeStatuses).toHaveLength(byslug.get(run.workflowSlug)!);
    }
  });

  test('the same seed reproduces the same history', () => {
    expect(plan({ seed: 42 })).toEqual(plan({ seed: 42 }));
  });

  test('an empty workflow list yields nothing instead of dividing by zero', () => {
    expect(plan({ workflows: [] })).toEqual([]);
    expect(plan({ statusMix: [] })).toEqual([]);
  });
});
