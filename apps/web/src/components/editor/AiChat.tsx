'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiError, getBrowserClient, StreamInterrupted } from '../../lib/api';
import { chatReducer, initialChatState } from '../../lib/chatMessages';
import { ConnectionDialog } from '../connections/ConnectionDialog';
import { AiChatMessage } from './AiChatMessage';
import { AiComposer } from './AiComposer';

interface AiChatProps {
  open: boolean;
  onClose: () => void;
  workflowId: string;
  onCanvasFrame: (frame: { workflowId: string; revision: number; definition: unknown }) => void;
}

const EXAMPLES = [
  'Ingatkan aku makan siang tiap jam 12 lewat Telegram.',
  'Kalau ada pesanan masuk lewat webhook dan totalnya di atas 100 ribu, kirim WhatsApp ke tim.',
  'Setiap Senin pagi, rekap penjualan minggu lalu dan kirim ke email saya.',
];

/**
 * The conversation.
 *
 * Deliberately not a chat-bubble layout: one left-aligned column, speaker marked by a
 * small uppercase label reusing the treatment already on `.q-library__group-title`, and a
 * rule down the left of the person's own turns. Bubbles and avatars would make this look
 * like every other assistant panel, and the thing that actually communicates progress
 * here is the row of tool chips, not the chrome.
 */
export function AiChat({ open, onClose, workflowId, onCanvasFrame }: AiChatProps): JSX.Element | null {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  // The composer's text is deliberately NOT in the reducer: it changes on every keystroke
  // and would rerender the whole transcript.
  const [draft, setDraft] = useState('');
  const [pendingConnector, setPendingConnector] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<string | null>(null);

  // One conversation per workflow, created lazily on first open so an unopened dock costs
  // nothing.
  useEffect(() => {
    if (!open || conversationRef.current) return;
    let cancelled = false;
    void getBrowserClient()
      .createConversation(workflowId)
      .then((c) => {
        if (cancelled) return;
        conversationRef.current = c.conversationId;
      })
      .catch((e: unknown) => setFatal(e instanceof Error ? e.message : 'Could not start a conversation'));
    return () => {
      cancelled = true;
    };
  }, [open, workflowId]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items]);

  const send = useCallback(
    async (text: string) => {
      const conversationId = conversationRef.current;
      if (!conversationId || streaming) return;
      setFatal(null);
      setDraft('');
      dispatch({ type: 'submit', id: `u-${Date.now()}`, text });
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      let seq = 0;
      try {
        for await (const frame of getBrowserClient().streamChat(conversationId, text, controller.signal)) {
          seq += 1;
          dispatch({ type: 'frame', seq, frame });
          if (frame['type'] === 'canvas') {
            onCanvasFrame({
              workflowId: String(frame['workflowId']),
              revision: Number(frame['revision']),
              definition: frame['definition'],
            });
          }
        }
      } catch (e) {
        if (e instanceof StreamInterrupted) dispatch({ type: 'interrupted' });
        else if (e instanceof ApiError && e.status === 503) {
          setFatal('The AI builder is not configured on this server (set OPENROUTER_API_KEY).');
        } else if (!controller.signal.aborted) {
          setFatal(e instanceof Error ? e.message : 'That reply could not be finished');
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [onCanvasFrame, streaming],
  );

  if (!open) return null;

  const waiting = state.items.find((i) => i.kind === 'connection' && !i.resolved);

  return (
    <aside className="q-aichat" data-testid="ai-dock" aria-label="Workflow builder">
      <div className="q-aichat__head">
        <span className="q-inspector__section-title">Build with AI</span>
        <Button variant="ghost" size="sm"
          
          onClick={onClose}
          disabled={pendingConnector !== null}
          aria-label="Close the builder">
          ✕
        </Button>
      </div>

      <div className="q-aichat__thread" ref={threadRef} data-testid="ai-thread" role="log" aria-live="polite">
        {state.items.length === 0 ? (
          <div className="q-aichat__empty" data-testid="ai-empty">
            <p>Describe the automation you want. I will build it, and tell you what it needs.</p>
            {EXAMPLES.map((example, i) => (
              <button
                key={example}
                className="q-aichat__example"
                data-testid={`ai-example-${i}`}
                onClick={() => setDraft(example)}
              >
                {example}
              </button>
            ))}
          </div>
        ) : (
          state.items.map((item, i) => (
            <AiChatMessage key={item.id + i} item={item} onConnect={(key) => setPendingConnector(key)} />
          ))
        )}
        {fatal ? (
          <div className="q-banner" data-testid="ai-error">
            {fatal}
          </div>
        ) : null}
      </div>

      <AiComposer
        value={draft}
        onChange={setDraft}
        onSubmit={() => void send(draft.trim())}
        onStop={() => abortRef.current?.abort()}
        streaming={streaming}
        disabled={waiting !== undefined}
        hint={waiting ? `Add the ${(waiting as { displayName: string }).displayName} connection, then carry on.` : undefined}
      />

      <ConnectionDialog
        open={pendingConnector !== null}
        onClose={() => setPendingConnector(null)}
        {...(pendingConnector ? { presetConnectorKey: pendingConnector } : {})}
        onCreated={() => {
          const key = pendingConnector;
          setPendingConnector(null);
          if (key) dispatch({ type: 'connectionCreated', connectorKey: key });
          void queryClient.invalidateQueries({ queryKey: ['connections'] });
        }}
      />
    </aside>
  );
}
