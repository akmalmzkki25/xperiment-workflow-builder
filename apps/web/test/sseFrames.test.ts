import { describe, expect, test } from 'vitest';
import { createSseParser, parseFrame } from '../src/lib/sseFrames';

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe('createSseParser', () => {
  test('one event split across three chunks yields exactly one event, and nothing early', () => {
    // The defect this catches: emitting on every chunk, so a half-arrived JSON payload
    // reaches JSON.parse and the whole stream dies on the first big frame.
    const p = createSseParser();
    expect(p.push('event: te')).toEqual([]);
    expect(p.push('xt\nda')).toEqual([]);
    const out = p.push('ta: {"delta":"hi"}\n\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: 'text', data: '{"delta":"hi"}' });
  });

  test('two complete events in one chunk yield two, in order', () => {
    const p = createSseParser();
    const out = p.push(`event: a\ndata: 1\n\nevent: b\ndata: 2\n\n`);
    expect(out.map((e) => e.event)).toEqual(['a', 'b']);
  });

  test('a keep-alive comment yields nothing AND does not disturb an event in progress', () => {
    // The single most likely way to corrupt a hand-rolled parser: treating the ping as a
    // boundary and flushing half an event.
    const p = createSseParser();
    p.push('event: text\n');
    expect(p.push(': ping\n\n')).toEqual([]);
    const out = p.push('data: {"delta":"still here"}\n\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toContain('still here');
  });

  test('multiple data lines join with a newline, per the spec', () => {
    // Where a JSON payload containing a newline silently corrupts.
    const p = createSseParser();
    const out = p.push('event: x\ndata: {"a":\ndata: 1}\n\n');
    expect(out[0]!.data).toBe('{"a":\n1}');
  });

  test('CRLF parses identically to LF, because a proxy may rewrite them', () => {
    const p = createSseParser();
    const out = p.push('event: text\r\ndata: {"delta":"hi"}\r\n\r\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe('text');
  });

  test('the id line becomes the resume cursor', () => {
    const p = createSseParser();
    const out = p.push('event: text\nid: 7\ndata: {}\n\n');
    expect(out[0]!.id).toBe('7');
  });

  test('flush discards a partial event rather than emitting a truncated one', () => {
    const p = createSseParser();
    p.push('event: text\ndata: {"delta":"cut off');
    expect(p.flush()).toEqual([]);
  });
});

describe('parseFrame', () => {
  test('turns a well-formed event into a typed frame', () => {
    const [ev] = createSseParser().push(frame({ type: 'text', messageId: 'm1', delta: 'hi' }));
    expect(parseFrame(ev!)).toMatchObject({ type: 'text', delta: 'hi' });
  });

  test('bad JSON returns null rather than throwing, so one bad frame is not a dead stream', () => {
    expect(parseFrame({ event: 'text', data: '{broken' })).toBeNull();
  });

  test('an unknown frame type returns null, so an older browser survives a newer server', () => {
    expect(parseFrame({ event: 'invented', data: '{"type":"invented"}' })).toBeNull();
  });

  test('the payload type decides, not the event name', () => {
    // Two sources of truth is two ways to disagree; the frames are self-describing.
    expect(parseFrame({ event: 'anything', data: '{"type":"done","stopReason":"complete"}' })).toMatchObject({
      type: 'done',
    });
  });
});
