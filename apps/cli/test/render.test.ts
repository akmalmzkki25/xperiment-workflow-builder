import { describe, expect, test } from 'vitest';
import { renderTimeline } from '../src/render.js';

describe('renderTimeline', () => {
  test('renders one line per attempt with status symbol and duration', () => {
    const out = renderTimeline({
      execution: { status: 'SUCCEEDED' },
      nodes: [
        {
          nodeId: 't',
          status: 'SUCCEEDED',
          attempt: 1,
          startedAt: '2026-07-23T00:00:00.000Z',
          completedAt: '2026-07-23T00:00:00.120Z',
        },
        {
          nodeId: 'call',
          status: 'RETRY_SCHEDULED',
          attempt: 1,
          startedAt: '2026-07-23T00:00:01.000Z',
          completedAt: '2026-07-23T00:00:01.300Z',
        },
        {
          nodeId: 'call',
          status: 'SUCCEEDED',
          attempt: 2,
          startedAt: '2026-07-23T00:00:02.000Z',
          completedAt: '2026-07-23T00:00:02.450Z',
        },
        { nodeId: 'skip-me', status: 'SKIPPED', attempt: 1, startedAt: null, completedAt: null },
      ],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Execution: SUCCEEDED');
    expect(lines).toContain('  [ok] t (attempt 1) SUCCEEDED 120ms');
    expect(lines).toContain('  [retry] call (attempt 1) RETRY_SCHEDULED 300ms');
    expect(lines).toContain('  [ok] call (attempt 2) SUCCEEDED 450ms');
    expect(lines).toContain('  [skip] skip-me (attempt 1) SKIPPED');
  });

  test('renders FAILED with [x]', () => {
    const out = renderTimeline({
      execution: { status: 'FAILED' },
      nodes: [{ nodeId: 'n', status: 'FAILED', attempt: 1, startedAt: null, completedAt: null }],
    });
    expect(out).toContain('[x] n (attempt 1) FAILED');
  });
});
