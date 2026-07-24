import { describe, expect, test } from 'vitest';
import { statusMeta } from '../src/lib/statusMeta';

describe('statusMeta', () => {
  test('terminal execution statuses map to semantic colors with glyphs', () => {
    expect(statusMeta('SUCCEEDED')).toEqual({ label: 'Succeeded', glyph: '✓', colorVar: '--status-succeeded' });
    expect(statusMeta('FAILED')).toEqual({ label: 'Failed', glyph: '✕', colorVar: '--status-failed' });
    expect(statusMeta('TIMED_OUT')).toEqual({ label: 'Timed out', glyph: '⏱', colorVar: '--status-failed' });
  });

  test('running pulses; queued/pending stay neutral', () => {
    expect(statusMeta('RUNNING')).toEqual({
      label: 'Running',
      glyph: '●',
      colorVar: '--status-running',
      pulse: true,
    });
    expect(statusMeta('QUEUED').colorVar).toBe('--status-neutral');
    expect(statusMeta('PENDING').colorVar).toBe('--status-neutral');
    expect(statusMeta('RETRY_SCHEDULED')).toEqual({ label: 'Retrying', glyph: '↻', colorVar: '--status-retry' });
    expect(statusMeta('WAITING')).toEqual({ label: 'Waiting', glyph: '⏸', colorVar: '--status-retry' });
    expect(statusMeta('SKIPPED')).toEqual({ label: 'Skipped', glyph: '○', colorVar: '--status-neutral' });
  });

  test('workflow statuses and unknown fallback', () => {
    expect(statusMeta('draft')).toEqual({ label: 'Draft', glyph: '◌', colorVar: '--status-neutral' });
    expect(statusMeta('published')).toEqual({ label: 'Published', glyph: '◆', colorVar: '--status-running' });
    expect(statusMeta('WEIRD')).toEqual({ label: 'WEIRD', glyph: '•', colorVar: '--status-neutral' });
  });
});
