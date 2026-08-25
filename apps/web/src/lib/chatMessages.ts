/**
 * The transcript, as a reducer.
 *
 * Pure and React-free so it can be tested in node — `apps/web`'s vitest has no jsdom and
 * measures coverage only over `src/lib/**`, so anything worth testing has to live here.
 *
 * The property that earns the file is replay idempotence. A dropped stream is resumed by
 * asking for everything after the last sequence number seen, and the server may replay a
 * frame the client already applied. Applying the same range twice has to be a no-op, and
 * that is not something you get by accident.
 */

export type ChatPhase = 'idle' | 'streaming' | 'awaiting_connection' | 'error';

export type ChatItem =
  | { kind: 'text'; id: string; role: 'user' | 'assistant'; text: string; pending: boolean }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      tool: string;
      title: string;
      args: Record<string, unknown>;
      state: 'running' | 'ok' | 'failed';
      summary?: string;
      ms?: number;
    }
  | { kind: 'connection'; id: string; connectorKey: string; displayName: string; nodeIds: string[]; requestId: string; resolved: boolean }
  | { kind: 'error'; id: string; code: string; title: string; detail?: string; retriable: boolean };

export interface ChatState {
  conversationId: string | null;
  items: ChatItem[];
  phase: ChatPhase;
  turn: { turnId: string; lastSeq: number } | null;
  /** Frame sequence numbers already applied, so a replay cannot double anything. */
  seen: ReadonlySet<number>;
}

export type ChatAction =
  | { type: 'submit'; id: string; text: string }
  | { type: 'frame'; seq: number; frame: Record<string, unknown> }
  | { type: 'interrupted' }
  | { type: 'connectionCreated'; connectorKey: string }
  | { type: 'hydrate'; conversationId: string; items: ChatItem[] };

export const initialChatState: ChatState = {
  conversationId: null,
  items: [],
  phase: 'idle',
  turn: null,
  seen: new Set(),
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'hydrate':
      return { ...initialChatState, conversationId: action.conversationId, items: action.items };

    case 'submit':
      return {
        ...state,
        phase: 'streaming',
        items: [...state.items, { kind: 'text', id: action.id, role: 'user', text: action.text, pending: false }],
      };

    case 'interrupted':
      // Not an error: the stream dropped and a resume is about to be attempted. Clearing
      // the caret stops it blinking forever if the resume never lands.
      return { ...state, items: clearPending(state.items) };

    case 'connectionCreated': {
      const items = state.items.map((i) =>
        i.kind === 'connection' && i.connectorKey === action.connectorKey ? { ...i, resolved: true } : i,
      );
      const stillWaiting = items.some((i) => i.kind === 'connection' && !i.resolved);
      return { ...state, items, phase: stillWaiting ? state.phase : 'idle' };
    }

    case 'frame':
      if (state.seen.has(action.seq)) return state;
      return applyFrame({ ...state, seen: new Set(state.seen).add(action.seq) }, action.frame);

    default:
      return state;
  }
}

function clearPending(items: ChatItem[]): ChatItem[] {
  return items.map((i) => (i.kind === 'text' && i.pending ? { ...i, pending: false } : i));
}

function applyFrame(state: ChatState, frame: Record<string, unknown>): ChatState {
  switch (frame['type']) {
    case 'turn':
      return {
        ...state,
        conversationId: str(frame['conversationId'], state.conversationId ?? ''),
        turn: { turnId: str(frame['turnId']), lastSeq: 0 },
        phase: 'streaming',
      };

    case 'text': {
      const messageId = str(frame['messageId']);
      const delta = str(frame['delta']);
      const last = state.items.at(-1);
      // Appending into the trailing run when the messageId matches is what makes
      // streaming look like typing rather than like a stack of one-character messages.
      // A text frame arriving AFTER a tool chip starts a new run, so narration keeps its
      // order relative to the work it describes.
      if (last && last.kind === 'text' && last.role === 'assistant' && last.id === messageId) {
        return {
          ...state,
          items: [...state.items.slice(0, -1), { ...last, text: last.text + delta, pending: true }],
        };
      }
      return {
        ...state,
        items: [...state.items, { kind: 'text', id: messageId, role: 'assistant', text: delta, pending: true }],
      };
    }

    case 'tool.start':
      return {
        ...state,
        items: [
          ...clearPending(state.items),
          {
            kind: 'tool',
            id: str(frame['callId']),
            callId: str(frame['callId']),
            tool: str(frame['tool']),
            title: str(frame['title']),
            args: (frame['args'] as Record<string, unknown>) ?? {},
            state: 'running',
          },
        ],
      };

    case 'tool.end': {
      const callId = str(frame['callId']);
      // Matched by callId. An unknown one is dropped rather than appended as a ghost chip
      // that never had a start.
      if (!state.items.some((i) => i.kind === 'tool' && i.callId === callId)) return state;
      return {
        ...state,
        items: state.items.map((i) =>
          i.kind === 'tool' && i.callId === callId
            ? { ...i, state: frame['ok'] === true ? 'ok' : 'failed', summary: str(frame['summary']), ms: Number(frame['ms'] ?? 0) }
            : i,
        ),
      };
    }

    case 'connection.required': {
      const requestId = str(frame['requestId']);
      if (state.items.some((i) => i.kind === 'connection' && i.requestId === requestId)) return state;
      return {
        ...state,
        phase: 'awaiting_connection',
        items: [
          ...clearPending(state.items),
          {
            kind: 'connection',
            id: requestId,
            requestId,
            connectorKey: str(frame['connectorKey']),
            displayName: str(frame['displayName'], str(frame['connectorKey'])),
            nodeIds: Array.isArray(frame['nodeIds']) ? (frame['nodeIds'] as string[]) : [],
            resolved: false,
          },
        ],
      };
    }

    case 'error':
      return {
        ...state,
        phase: 'error',
        items: [
          ...clearPending(state.items),
          {
            kind: 'error',
            id: `err-${state.items.length}`,
            code: str(frame['code']),
            title: str(frame['title'], 'Something went wrong'),
            ...(typeof frame['detail'] === 'string' ? { detail: frame['detail'] } : {}),
            retriable: frame['retriable'] === true,
          },
        ],
      };

    case 'done': {
      const stop = str(frame['stopReason']);
      return {
        ...state,
        items: clearPending(state.items),
        phase: stop === 'awaiting_connection' ? 'awaiting_connection' : stop === 'error' ? 'error' : 'idle',
        turn: null,
      };
    }

    default:
      return state;
  }
}
