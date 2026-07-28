import { describe, expect, test } from 'vitest';
import {
  evaluateQuota,
  isBlocked,
  periodEnd,
  periodStart,
  PLAN_CATALOG,
  resolveLimits,
  SOFT_LIMIT_RATIO,
  type PlanLimits,
} from '../src/index.js';

const zero = { executionsPerMonth: 0, aiTokensPerMonth: 0, activeWorkflows: 0, members: 0 };

describe('PLAN_CATALOG', () => {
  test('every tier defines all four limits', () => {
    for (const [code, limits] of Object.entries(PLAN_CATALOG)) {
      for (const key of ['executionsPerMonth', 'aiTokensPerMonth', 'activeWorkflows', 'members'] as const) {
        expect(limits[key] === null || limits[key]! > 0, `${code}.${key}`).toBe(true);
      }
    }
  });

  test('business is the unlimited tier', () => {
    expect(PLAN_CATALOG.business).toEqual({
      executionsPerMonth: null,
      aiTokensPerMonth: null,
      activeWorkflows: null,
      members: null,
    });
  });
});

describe('resolveLimits', () => {
  test('overrides replace catalog values, including making one unlimited', () => {
    const limits = resolveLimits('free', { executionsPerMonth: 99, activeWorkflows: null });
    expect(limits.executionsPerMonth).toBe(99);
    expect(limits.activeWorkflows).toBeNull();
    expect(limits.members).toBe(PLAN_CATALOG.free.members);
  });

  test('an unknown code falls back to free rather than to unlimited', () => {
    expect(resolveLimits('nope' as never, {})).toEqual(PLAN_CATALOG.free);
  });
});

describe('evaluateQuota', () => {
  const limits: PlanLimits = { executionsPerMonth: 100, aiTokensPerMonth: null, activeWorkflows: 3, members: 2 };
  const line = (used: Partial<typeof zero>, overage = false) => evaluateQuota(limits, { ...zero, ...used }, overage);

  test('well under the limit is ok', () => {
    expect(line({ executionsPerMonth: 50 })[0]).toMatchObject({ metric: 'executionsPerMonth', used: 50, status: 'ok' });
  });

  test('exactly at the soft threshold warns', () => {
    const used = 100 * SOFT_LIMIT_RATIO;
    expect(line({ executionsPerMonth: used })[0]!.status).toBe('warn');
  });

  test('one below the soft threshold is still ok', () => {
    expect(line({ executionsPerMonth: 100 * SOFT_LIMIT_RATIO - 1 })[0]!.status).toBe('ok');
  });

  test('exactly at the limit blocks', () => {
    expect(line({ executionsPerMonth: 100 })[0]!.status).toBe('blocked');
  });

  test('over the limit blocks', () => {
    expect(line({ executionsPerMonth: 101 })[0]!.status).toBe('blocked');
  });

  test('overage turns blocked into warn but never ok', () => {
    expect(line({ executionsPerMonth: 500 }, true)[0]!.status).toBe('warn');
  });

  test('a null limit is always ok, however large the usage', () => {
    const l = line({ aiTokensPerMonth: 9_999_999 }).find((x) => x.metric === 'aiTokensPerMonth')!;
    expect(l).toMatchObject({ limit: null, status: 'ok' });
  });

  test('returns one line per limit key', () => {
    expect(
      line({})
        .map((l) => l.metric)
        .sort(),
    ).toEqual(['activeWorkflows', 'aiTokensPerMonth', 'executionsPerMonth', 'members']);
  });
});

describe('isBlocked', () => {
  test('is true only for the named blocked metric', () => {
    const lines = evaluateQuota(
      { executionsPerMonth: 1, aiTokensPerMonth: 1, activeWorkflows: null, members: null },
      { ...zero, executionsPerMonth: 5 },
      false,
    );
    expect(isBlocked(lines, 'executionsPerMonth')).toBe(true);
    expect(isBlocked(lines, 'aiTokensPerMonth')).toBe(false);
    expect(isBlocked(lines, 'activeWorkflows')).toBe(false);
  });
});

describe('period boundaries', () => {
  test('periodStart is the first instant of the UTC month', () => {
    expect(periodStart(new Date('2026-07-28T13:45:00Z')).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('a UTC month boundary belongs to the new month', () => {
    expect(periodStart(new Date('2026-08-01T00:00:00Z')).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('periodEnd rolls the year over', () => {
    expect(periodEnd(new Date('2026-12-01T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
