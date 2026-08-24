import { describe, expect, test } from 'vitest';
import { toolTone } from '../src/components/editor/AiChatMessage';

describe('toolTone', () => {
  test('a tool call is never painted with the live signal colour', () => {
    // --color-arus is reserved for live/active signals (tokens.css). An agent calling a
    // tool is not a running workflow, and that rule otherwise lives only in a CSS comment
    // nobody reads.
    for (const state of ['running', 'ok', 'failed'] as const) {
      expect(toolTone(state).colorVar, state).not.toContain('arus');
    }
  });

  test('each state maps to its own status token and glyph', () => {
    expect(toolTone('running')).toEqual({ colorVar: 'var(--status-running)', glyph: '◐' });
    expect(toolTone('ok')).toEqual({ colorVar: 'var(--status-succeeded)', glyph: '✓' });
    expect(toolTone('failed')).toEqual({ colorVar: 'var(--status-failed)', glyph: '✕' });
  });
});
