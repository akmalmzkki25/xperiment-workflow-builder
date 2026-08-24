'use client';

import type { KeyboardEvent } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  hint?: string;
}

/**
 * The input.
 *
 * Enter sends and Shift+Enter inserts a newline, which is what a chat box is expected to
 * do and costs one keydown handler rather than a library. While a turn is running the
 * primary button becomes Stop, because a turn can take a minute and having no way out of
 * it is worse than the wait.
 */
export function AiComposer({ value, onChange, onSubmit, onStop, streaming, disabled, hint }: Props): JSX.Element {
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !streaming && !disabled) onSubmit();
    }
  }

  return (
    <div className="q-aichat__composer">
      {hint ? <p className="q-field__hint">{hint}</p> : null}
      <textarea
        className="q-textarea"
        data-testid="ai-prompt"
        rows={3}
        value={value}
        disabled={disabled}
        placeholder="Describe what you want to automate…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {streaming ? (
        <button className="q-btn q-btn--ghost q-btn--sm" data-testid="ai-stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button
          className="q-btn q-btn--live q-btn--sm"
          data-testid="ai-send"
          disabled={!value.trim() || disabled}
          onClick={onSubmit}
        >
          Send
        </button>
      )}
    </div>
  );
}
