'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, getBrowserClient } from '../../lib/api';

interface AiDockProps {
  open: boolean;
  onClose: () => void;
  hasNodes: boolean;
  currentDefinition: () => Record<string, unknown>;
  onApply: (ir: unknown) => void;
}

export function AiDock({ open, onClose, hasNodes, currentDefinition, onApply }: AiDockProps) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (mode: 'generate' | 'edit') =>
      mode === 'edit'
        ? getBrowserClient().aiEdit(prompt, currentDefinition())
        : getBrowserClient().aiGenerate(prompt),
    onSuccess: ({ ir }) => {
      setError(null);
      onApply(ir);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 503) {
        setError('AI is not configured on the server (set OPENROUTER_API_KEY).');
      } else {
        setError(e instanceof Error ? e.message : 'AI request failed');
      }
    },
  });

  if (!open) return null;

  return (
    <aside className="q-aidock" data-testid="ai-dock">
      <div className="q-aidock__head">
        <span className="q-inspector__section-title">Build with AI</span>
        <button className="q-btn q-btn--ghost q-btn--sm" onClick={onClose} aria-label="Close AI dock">
          ✕
        </button>
      </div>
      <textarea
        className="q-textarea"
        placeholder="Describe the workflow — e.g. “When a webhook arrives, if total > 100 send a Telegram message.”"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        data-testid="ai-prompt"
        rows={5}
      />
      <div className="q-aidock__actions">
        <button
          className="q-btn q-btn--live q-btn--sm"
          disabled={!prompt.trim() || run.isPending}
          onClick={() => run.mutate('generate')}
          data-testid="ai-generate"
          title={hasNodes ? 'Replaces the current canvas' : undefined}
        >
          {run.isPending ? 'Generating…' : hasNodes ? 'Generate (replace)' : 'Generate'}
        </button>
        {hasNodes ? (
          <button
            className="q-btn q-btn--ghost q-btn--sm"
            disabled={!prompt.trim() || run.isPending}
            onClick={() => run.mutate('edit')}
            data-testid="ai-edit"
          >
            Edit current
          </button>
        ) : null}
      </div>
      <p className="q-field__hint">The AI produces a draft you still review, save, and publish — it never publishes for you.</p>
      {error ? (
        <div className="q-banner" data-testid="ai-error">
          {error}
        </div>
      ) : null}
    </aside>
  );
}
