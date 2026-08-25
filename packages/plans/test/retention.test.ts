import { describe, expect, test } from 'vitest';
import {
  AUDIT_RETENTION_FLOOR_DAYS,
  PLAN_CATALOG,
  PLAN_CODES,
  PLAN_RETENTION,
  USAGE_RETENTION_FLOOR_DAYS,
} from '../src/index.js';

describe('PLAN_RETENTION', () => {
  test('covers every plan in the catalog', () => {
    // The sweep in @xperiment/db joins each workspace to this table by plan code and falls
    // back to the caller's own retention when it finds nothing. A plan added to the
    // catalog and forgotten here would silently keep whatever the operator happened to
    // pass, which is the exact failure that made this table dead code for months.
    expect(Object.keys(PLAN_RETENTION).sort()).toEqual([...PLAN_CODES].sort());
    expect(Object.keys(PLAN_RETENTION).sort()).toEqual(Object.keys(PLAN_CATALOG).sort());
  });

  test('a bigger plan never keeps less than a smaller one', () => {
    const ladder = PLAN_CODES.map((code) => PLAN_RETENTION[code].executionDays);
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
  });

  test('webhook bodies are never kept for less time than the runs that used them', () => {
    // Otherwise every sweep would unhook the same executions again. `pruneExpired` floors
    // this defensively, but the catalog should not need the floor.
    for (const code of PLAN_CODES) {
      expect(PLAN_RETENTION[code].triggerEventDays).toBeGreaterThanOrEqual(
        PLAN_RETENTION[code].executionDays,
      );
    }
  });

  test('no plan reaches the audit or usage floors', () => {
    // Not an accident to preserve — a plan that outlived a floor would mean run history
    // survives the record of who created it.
    for (const code of PLAN_CODES) {
      expect(PLAN_RETENTION[code].executionDays).toBeLessThanOrEqual(USAGE_RETENTION_FLOOR_DAYS);
    }
    expect(AUDIT_RETENTION_FLOOR_DAYS).toBeGreaterThan(PLAN_RETENTION.free.executionDays);
  });
});
