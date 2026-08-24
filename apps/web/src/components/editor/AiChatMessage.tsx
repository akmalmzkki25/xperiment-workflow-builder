'use client';

import type { ChatItem } from '../../lib/chatMessages';

/**
 * One row of the transcript.
 *
 * Tool chips reuse `.q-chip`, coloured from the status tokens — never `--color-arus`.
 * The lime is reserved for live/active signals, and an agent calling a tool is not a
 * running workflow. That rule lives in a CSS comment nobody reads, so `toolTone` below is
 * the only place it can be got wrong, and a test asserts it.
 */
export function toolTone(state: 'running' | 'ok' | 'failed'): { colorVar: string; glyph: string } {
  if (state === 'ok') return { colorVar: 'var(--status-succeeded)', glyph: '✓' };
  if (state === 'failed') return { colorVar: 'var(--status-failed)', glyph: '✕' };
  return { colorVar: 'var(--status-running)', glyph: '◐' };
}

interface Props {
  item: ChatItem;
  onConnect: (connectorKey: string) => void;
}

export function AiChatMessage({ item, onConnect }: Props): JSX.Element {
  if (item.kind === 'text') {
    const mine = item.role === 'user';
    return (
      <div
        className={mine ? 'q-aichat__turn q-aichat__turn--mine' : 'q-aichat__turn'}
        data-testid={`ai-msg-${item.role}`}
      >
        <span className="q-aichat__who">{mine ? 'You' : 'Xperiment'}</span>
        <p className="q-aichat__body">
          {item.text}
          {item.pending ? <span className="q-aichat__caret">▋</span> : null}
        </p>
      </div>
    );
  }

  if (item.kind === 'tool') {
    const tone = toolTone(item.state);
    return (
      <span
        className="q-chip q-aichat__tool"
        style={{ color: tone.colorVar }}
        data-testid={`ai-tool-${item.tool}`}
        data-state={item.state}
      >
        <span className={item.state === 'running' ? 'q-chip__glyph q-chip__glyph--pulse' : 'q-chip__glyph'}>
          {tone.glyph}
        </span>
        {item.state === 'failed' ? `${item.title} — ${item.summary ?? 'failed'}` : item.title}
      </span>
    );
  }

  if (item.kind === 'connection') {
    // Deliberately not `.q-banner`: that class is coral-bordered and reads as an error,
    // and needing a credential is not an error.
    return (
      <div className="q-aichat__callout" data-testid="ai-connection-callout">
        <span className="q-chip" style={{ color: 'var(--color-tide)' }}>
          {item.connectorKey}
        </span>
        <p>
          This needs a {item.displayName} connection
          {item.nodeIds.length > 0 ? (
            <>
              {' '}
              for <code className="mono">{item.nodeIds.join(', ')}</code>
            </>
          ) : null}
          .
        </p>
        <p className="q-field__hint">Xperiment stores this encrypted. Paste it into the form — never into the chat.</p>
        {item.resolved ? (
          <span className="q-chip" style={{ color: 'var(--status-succeeded)' }} data-testid="ai-connected">
            ✓ Connected
          </span>
        ) : (
          <button
            className="q-btn q-btn--sm"
            data-testid={`ai-connect-${item.connectorKey}`}
            onClick={() => onConnect(item.connectorKey)}
          >
            Connect {item.displayName}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="q-banner" data-testid="ai-error">
      {item.title}
      {item.detail ? ` — ${item.detail}` : ''}
    </div>
  );
}
