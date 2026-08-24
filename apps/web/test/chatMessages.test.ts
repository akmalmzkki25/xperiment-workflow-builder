import { describe, expect, test } from 'vitest';
import { chatReducer, initialChatState, type ChatState } from '../src/lib/chatMessages';
import { decideCanvasSync } from '../src/lib/canvasSync';

let seq = 0;
function apply(state: ChatState, ...frames: Record<string, unknown>[]): ChatState {
  return frames.reduce((s, frame) => chatReducer(s, { type: 'frame', seq: (seq += 1), frame }), state);
}
const text = (messageId: string, delta: string) => ({ type: 'text', messageId, delta });

describe('chatReducer', () => {
  test('two deltas with the same messageId become ONE item, not two', () => {
    // The single most likely defect, and the one that makes streaming look broken.
    const s = apply(initialChatState, text('m1', 'Halo'), text('m1', ', saya buatkan.'));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'text', text: 'Halo, saya buatkan.', pending: true });
  });

  test('text after a tool chip starts a new run, so narration keeps its order', () => {
    const s = apply(
      initialChatState,
      text('m1', 'Sebentar'),
      { type: 'tool.start', callId: 'c1', tool: 'create_workflow', title: 'Creating the workflow', args: {} },
      text('m2', 'Sudah.'),
    );
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text']);
  });

  test('tool.end matches by callId and flips only that chip', () => {
    const s = apply(
      initialChatState,
      { type: 'tool.start', callId: 'c1', tool: 'a', title: 'A', args: {} },
      { type: 'tool.start', callId: 'c2', tool: 'b', title: 'B', args: {} },
      { type: 'tool.end', callId: 'c2', ok: true, summary: 'done', ms: 4 },
    );
    expect(s.items.map((i) => (i.kind === 'tool' ? i.state : ''))).toEqual(['running', 'ok']);
  });

  test('a tool.end with no matching start is dropped, not shown as a ghost chip', () => {
    const s = apply(initialChatState, { type: 'tool.end', callId: 'never-started', ok: true });
    expect(s.items).toEqual([]);
  });

  test('replaying the same sequence range twice leaves the transcript identical', () => {
    // What makes reconnection safe, and impossible to get right by accident.
    const frames = [text('m1', 'Ha'), text('m1', 'lo'), { type: 'done', stopReason: 'complete' }];
    let a = initialChatState;
    frames.forEach((f, i) => (a = chatReducer(a, { type: 'frame', seq: 100 + i, frame: f })));
    let b = a;
    frames.forEach((f, i) => (b = chatReducer(b, { type: 'frame', seq: 100 + i, frame: f })));
    expect(b.items).toEqual(a.items);
  });

  test('a second connection.required for the same request does not stack up', () => {
    const frame = {
      type: 'connection.required',
      connectorKey: 'telegram',
      displayName: 'Telegram',
      requestId: 'r1',
      nodeIds: ['notify'],
    };
    const s = apply(initialChatState, frame, { ...frame });
    expect(s.items.filter((i) => i.kind === 'connection')).toHaveLength(1);
    expect(s.phase).toBe('awaiting_connection');
  });

  test('creating the matching connection resolves the callout and frees the composer', () => {
    let s = apply(initialChatState, {
      type: 'connection.required',
      connectorKey: 'telegram',
      displayName: 'Telegram',
      requestId: 'r1',
      nodeIds: [],
    });
    s = chatReducer(s, { type: 'connectionCreated', connectorKey: 'slack' });
    expect(s.phase, 'a different connector changes nothing').toBe('awaiting_connection');
    s = chatReducer(s, { type: 'connectionCreated', connectorKey: 'telegram' });
    expect(s.phase).toBe('idle');
    expect(s.items.find((i) => i.kind === 'connection')).toMatchObject({ resolved: true });
  });

  test('done clears the caret, so it does not blink forever after a stop', () => {
    const s = apply(initialChatState, text('m1', 'partial'), { type: 'done', stopReason: 'aborted' });
    expect(s.items[0]).toMatchObject({ pending: false });
    expect(s.phase).toBe('idle');
  });

  test('an interrupted stream keeps the partial text but stops the caret', () => {
    let s = apply(initialChatState, text('m1', 'half a sen'));
    s = chatReducer(s, { type: 'interrupted' });
    expect(s.items[0]).toMatchObject({ text: 'half a sen', pending: false });
  });

  test('an error frame is placed in the transcript where it happened', () => {
    const s = apply(
      initialChatState,
      text('m1', 'trying'),
      { type: 'error', code: 'provider_error', title: 'Nothing came back', retriable: true },
    );
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'error']);
    expect(s.phase).toBe('error');
  });

  test('an unknown frame type is ignored rather than throwing', () => {
    const s = apply(initialChatState, { type: 'something.new', payload: 1 });
    expect(s.items).toEqual([]);
  });
});

describe('decideCanvasSync', () => {
  test('a clean canvas takes the update', () => {
    expect(decideCanvasSync({ workflowId: 'w1', revision: 4 }, { workflowId: 'w1', revision: 3, dirty: false })).toEqual({
      action: 'apply',
      revision: 4,
    });
  });

  test('a DIRTY canvas is never silently replaced', () => {
    // Offering costs one click. Clobbering costs whatever they had just built.
    expect(decideCanvasSync({ workflowId: 'w1', revision: 4 }, { workflowId: 'w1', revision: 3, dirty: true })).toEqual({
      action: 'offer',
      revision: 4,
    });
  });

  test('a replayed or older revision is ignored, so a resume cannot walk the canvas backwards', () => {
    expect(decideCanvasSync({ workflowId: 'w1', revision: 3 }, { workflowId: 'w1', revision: 3, dirty: false })).toEqual({
      action: 'ignore',
      reason: 'stale',
    });
  });

  test('a frame for another workflow is ignored — they navigated mid-turn', () => {
    expect(decideCanvasSync({ workflowId: 'w2', revision: 9 }, { workflowId: 'w1', revision: 1, dirty: false })).toEqual({
      action: 'ignore',
      reason: 'other-workflow',
    });
  });

  test('a canvas that never loaded a draft applies, because there is nothing to lose', () => {
    expect(decideCanvasSync({ workflowId: 'w1', revision: 1 }, { workflowId: 'w1', revision: null, dirty: false })).toEqual(
      { action: 'apply', revision: 1 },
    );
  });
});
