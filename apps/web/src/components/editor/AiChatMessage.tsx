'use client';

import type { ChatItem } from '../../lib/chatMessages';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * One row of the transcript.
 *
 * Tool chips use Badge's `tone` variant, coloured from the status tokens — never `--color-arus`.
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
      <Badge
        variant="tone" className="q-aichat__tool"
        style={{ color: tone.colorVar }}
        data-testid={`ai-tool-${item.tool}`}
        data-state={item.state}
      >
        <span className={item.state === 'running' ? 'animate-pulse-soft' : undefined}>
          {tone.glyph}
        </span>
        {item.state === 'failed' ? `${item.title} — ${item.summary ?? 'failed'}` : item.title}
      </Badge>
    );
  }

  if (item.kind === 'connection') {
    // Deliberately not an Alert: that reads as an error, and needing a credential is not
    // an error. A plain raised surface with a tide chip instead.
    return (
      <div className="q-aichat__callout" data-testid="ai-connection-callout">
        <Badge variant="tone" style={{ color: 'var(--color-tide)' }}>
          {item.connectorKey}
        </Badge>
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
        <p className="text-[length:var(--text-small)] text-muted-foreground">Xperiment stores this encrypted. Paste it into the form — never into the chat.</p>
        {item.resolved ? (
          <Badge variant="tone" style={{ color: 'var(--status-succeeded)' }} data-testid="ai-connected">
            ✓ Connected
          </Badge>
        ) : (
          <Button size="sm"
            
            data-testid={`ai-connect-${item.connectorKey}`}
            onClick={() => onConnect(item.connectorKey)}
          >
            Connect {item.displayName}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Alert className="flex flex-wrap items-center gap-3" data-testid="ai-error">
      {item.title}
      {item.detail ? ` — ${item.detail}` : ''}
    </Alert>
  );
}
