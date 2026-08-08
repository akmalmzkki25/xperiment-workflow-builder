'use client';

import { formatBytes, previewPayload } from '../../lib/payloadView';

interface Props {
  label: string;
  value: unknown;
  testId?: string;
}

/**
 * A disclosure for one recorded payload.
 *
 * Native `<details>`, so it is keyboard-accessible and needs no state at all — and so
 * a run with forty node attempts does not mount forty pieces of React state.
 */
export function PayloadPanel({ label, value, testId }: Props) {
  const preview = previewPayload(value);

  if (preview.empty) {
    return (
      <span className="q-field__hint" data-testid={testId ? `${testId}-empty` : undefined}>
        {label}: not recorded
      </span>
    );
  }

  const copy = () => {
    void navigator.clipboard.writeText(preview.text).catch(() => undefined);
  };

  return (
    <details data-testid={testId} style={{ width: '100%' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
        {label} <span className="q-field__hint">({formatBytes(preview.bytes)})</span>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        <pre className="q-payload" data-testid={testId ? `${testId}-body` : undefined}>
          {preview.text}
        </pre>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <button type="button" className="q-btn q-btn--ghost" onClick={copy}>
            Copy
          </button>
          {preview.truncated ? (
            <span className="q-field__hint">Shown truncated — copy gives you the same slice.</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
