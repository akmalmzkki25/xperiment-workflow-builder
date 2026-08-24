/**
 * Reading the agent's event stream.
 *
 * Split in two on purpose: `createSseParser` turns bytes into events (protocol), and
 * `parseFrame` turns one event into a typed frame (schema). The split is what lets a
 * long-poll fallback reuse half of this if streaming ever proves painful behind a proxy.
 *
 * Hand-rolled rather than `EventSource`, which cannot carry an Authorization header — so
 * the transport is `fetch` plus a reader regardless, and once you are reading bytes the
 * SSE wire format is just a convenient framing.
 */

export interface SseEvent {
  event: string;
  id?: string;
  data: string;
}

export interface SseParser {
  push(chunk: string): SseEvent[];
  flush(): SseEvent[];
}

const FRAME_TYPES = new Set([
  'turn',
  'text',
  'tool.start',
  'tool.end',
  'canvas',
  'connection.required',
  'error',
  'done',
]);

export function createSseParser(): SseParser {
  let buffer = '';

  function drain(): SseEvent[] {
    const events: SseEvent[] = [];
    // A blank line ends a record. Normalising CRLF first means a proxy that rewrites
    // line endings cannot change the parse.
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseRecord(record);
      if (parsed) events.push(parsed);
      boundary = buffer.indexOf('\n\n');
    }
    return events;
  }

  return {
    push(chunk) {
      buffer += chunk;
      return drain();
    },
    flush() {
      // A stream cut mid-record leaves a partial. Emitting it would hand JSON.parse half
      // a document; dropping it loses one frame the caller was going to resume anyway.
      buffer = '';
      return [];
    },
  };
}

function parseRecord(record: string): SseEvent | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of record.split('\n')) {
    // A comment line is the keep-alive. It must not disturb anything.
    if (line.startsWith(':') || line.length === 0) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon is stripped, per the spec.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, ...(id !== undefined ? { id } : {}), data: data.join('\n') };
}

/**
 * One event to a typed frame. Returns null rather than throwing: one bad frame must not
 * kill the stream, and an older browser must survive a server that learned a new type.
 *
 * Keyed on the payload's own `type` rather than the SSE event name. The frames are
 * self-describing, the event name is a convenience for anything reading the raw wire, and
 * trusting one source rather than two removes a way for them to disagree.
 */
export function parseFrame(ev: SseEvent): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(ev.data) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return FRAME_TYPES.has(String(parsed['type'])) ? parsed : null;
  } catch {
    return null;
  }
}
