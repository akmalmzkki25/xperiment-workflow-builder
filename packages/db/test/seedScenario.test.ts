import { workflowIrSchema } from '@xperiment/ir';
import { describe, expect, test } from 'vitest';
import { isFakeCredential } from '../src/seed/guard.js';
import { SEED_CONNECTIONS, SEED_STATUS_MIX, SEED_WORKFLOWS, weightedPick } from '../src/seed/scenario.js';

describe('seed workflows', () => {
  test('every demo definition is valid IR, not decoration', () => {
    // A demo workspace whose workflows fail validation the moment someone opens one
    // is worse than no demo at all.
    for (const wf of SEED_WORKFLOWS) {
      const parsed = workflowIrSchema.safeParse(wf.definition);
      expect(parsed.success, `${wf.slug}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  test('slugs are unique', () => {
    const slugs = SEED_WORKFLOWS.map((w) => w.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('names read like a shop, not like a fixture', () => {
    for (const wf of SEED_WORKFLOWS) {
      // Word boundaries matter: "Pesanan baru" contains "bar" as a substring.
      expect(wf.name).not.toMatch(/\b(test|foo|bar|workflow[-\s]?\d)\b/i);
      expect(wf.name.length).toBeGreaterThan(8);
    }
  });
});

describe('seed connections', () => {
  test('every credential is unmistakably fabricated', () => {
    for (const conn of SEED_CONNECTIONS) {
      const values = Object.values(conn.payload).filter((v): v is string => typeof v === 'string');
      const secrets = values.filter((v) => !/^\d+$/.test(v));
      expect(secrets.every(isFakeCredential), conn.connectorKey).toBe(true);
    }
  });

  test('no demo host can ever resolve', () => {
    // RFC 2606 reserves .invalid. A demo that could actually reach a provider is a
    // demo that eventually sends a real message to a real person.
    for (const conn of SEED_CONNECTIONS) {
      const baseUrl = conn.payload['baseUrl'];
      expect(typeof baseUrl === 'string' && baseUrl.endsWith('.invalid'), conn.connectorKey).toBe(true);
    }
  });
});

describe('status mix', () => {
  test('includes failures, or the run list has nothing to teach', () => {
    const statuses = SEED_STATUS_MIX.map((s) => s.status);
    expect(statuses).toContain('SUCCEEDED');
    expect(statuses).toContain('FAILED');
    expect(SEED_STATUS_MIX.find((s) => s.status === 'FAILED')!.weight).toBeGreaterThan(0);
  });

  test('successes still dominate, so the demo looks like a working shop', () => {
    const total = SEED_STATUS_MIX.reduce((sum, s) => sum + s.weight, 0);
    const ok = SEED_STATUS_MIX.find((s) => s.status === 'SUCCEEDED')!.weight;
    expect(ok / total).toBeGreaterThan(0.7);
  });
});

describe('weightedPick', () => {
  const items = [
    { status: 'a', weight: 1 },
    { status: 'b', weight: 3 },
  ];

  test('respects the weights across the range', () => {
    expect(weightedPick(items, 0).status).toBe('a');
    expect(weightedPick(items, 0.2).status).toBe('a');
    expect(weightedPick(items, 0.3).status).toBe('b');
    expect(weightedPick(items, 0.99).status).toBe('b');
  });

  test('a fraction at or past the end still returns an item', () => {
    // Floating point at the boundary must not fall off the list.
    expect(weightedPick(items, 1).status).toBe('b');
    expect(weightedPick(items, 1.5).status).toBe('b');
    expect(weightedPick(items, -1).status).toBe('a');
  });

  test('is deterministic for a given fraction', () => {
    expect(weightedPick(items, 0.42)).toBe(weightedPick(items, 0.42));
  });
});
