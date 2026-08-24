/**
 * What one turn emits, in order.
 *
 * A numbered sequence of typed frames rather than a lump of JSON at the end, because a
 * turn that calls four tools takes tens of seconds and silence for that long is
 * indistinguishable from a hang. The tool frames ARE the progress indicator; that is the
 * whole reason this protocol exists.
 *
 * The transport is deliberately not part of this file. Frames are handed to an `emit`
 * callback, so the turn logic is testable with `app.inject()` — which cannot drive a
 * hijacked reply — while the Fastify route stays a thin adapter that serialises them.
 */
export type ChatFrame =
  /** Always first, before the first model call, so the client owns a handle even if the provider dies immediately. */
  | { type: 'turn'; turnId: string; conversationId: string; workflowId: string | null }
  /** Assistant prose. A delta, never cumulative. */
  | { type: 'text'; messageId: string; delta: string }
  | { type: 'tool.start'; callId: string; tool: string; title: string; args: Record<string, unknown> }
  | { type: 'tool.end'; callId: string; tool: string; ok: boolean; summary: string; ms: number }
  /** After any tool writes the draft. Carries the definition so the browser never races a follow-up GET. */
  | { type: 'canvas'; workflowId: string; revision: number; definition: unknown }
  /** Structured signal only — the prose already went out as `text`. */
  | {
      type: 'connection.required';
      connectorKey: string;
      displayName: string;
      nodeIds: string[];
      requestId: string;
      formUrl: string;
    }
  /** Shaped like RFC 7807 so the browser renders it through the same path as an ApiError. */
  | { type: 'error'; code: string; title: string; detail?: string; retriable: boolean }
  | { type: 'done'; turnId: string; stopReason: StopReason; tokens: number };

export type StopReason = 'complete' | 'awaiting_connection' | 'aborted' | 'error' | 'refused' | 'budget';

export type Emit = (frame: ChatFrame) => void | Promise<void>;

/** Human phrasing for a tool call, so the chip does not read as a function name. */
const TOOL_TITLES: Record<string, [running: string, done: string]> = {
  describe_node_type: ['Looking up a node type', 'Looked up a node type'],
  list_connections: ['Checking your connections', 'Checked your connections'],
  get_credential_guide: ['Reading the setup guide', 'Read the setup guide'],
  list_workflows: ['Looking through your workflows', 'Looked through your workflows'],
  get_workflow: ['Reading the workflow', 'Read the workflow'],
  create_workflow: ['Creating the workflow', 'Created the workflow'],
  put_draft: ['Saving the draft', 'Saved the draft'],
  set_node_connection: ['Connecting the node', 'Connected the node'],
  validate_workflow: ['Checking it over', 'Checked it over'],
  request_credential: ['Asking for a credential', 'Asked for a credential'],
};

export function toolTitle(tool: string, done: boolean): string {
  const pair = TOOL_TITLES[tool];
  if (!pair) return done ? `Ran ${tool}` : `Running ${tool}`;
  return done ? pair[1] : pair[0];
}

/** One SSE record. `id` is the resume cursor; a comment line is the keep-alive. */
export function encodeFrame(seq: number, frame: ChatFrame): string {
  return `event: ${frame.type}\nid: ${seq}\ndata: ${JSON.stringify(frame)}\n\n`;
}
