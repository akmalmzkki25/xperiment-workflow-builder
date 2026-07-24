'use client';

import type { TriggerView } from '../../lib/api';

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      className="q-btn q-btn--ghost q-btn--sm"
      type="button"
      onClick={() => void navigator.clipboard.writeText(value).catch(() => undefined)}
    >
      Copy {label}
    </button>
  );
}

export function TriggerPanel({ triggers, showSecrets }: { triggers: TriggerView[]; showSecrets: boolean }) {
  if (triggers.length === 0) return null;
  return (
    <div className="q-trigger-panel" data-testid="trigger-panel">
      <div className="q-inspector__section-title">Triggers</div>
      {triggers.map((t) => (
        <div key={t.nodeId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <strong className="mono">{t.nodeId}</strong>
          {t.type === 'webhook' ? (
            <>
              <div className="q-trigger-panel__url">
                <code data-testid="trigger-url">{t.url}</code>
                <CopyButton value={t.url ?? ''} label="URL" />
              </div>
              <div className="q-trigger-panel__url">
                <code data-testid="trigger-test-url">{t.testUrl}</code>
                <CopyButton value={t.testUrl ?? ''} label="test URL" />
              </div>
              {t.authMode && t.authMode !== 'none' ? (
                showSecrets && t.secret ? (
                  <div className="q-banner q-banner--warn">
                    <span>
                      {t.authMode} secret (copy it now — treat it like a password):{' '}
                      <code data-testid="trigger-secret">{t.secret}</code>
                    </span>
                    <CopyButton value={t.secret} label="secret" />
                  </div>
                ) : (
                  <p className="q-field__hint">Auth: {t.authMode} — secret managed at activation.</p>
                )
              ) : (
                <p className="q-field__hint">Auth: none</p>
              )}
            </>
          ) : (
            <p className="q-field__hint">
              cron <code>{t.cron}</code> · {t.timezone} · next fire {t.nextFireAt ?? '—'}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
