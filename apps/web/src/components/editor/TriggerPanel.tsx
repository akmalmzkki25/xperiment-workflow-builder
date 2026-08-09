'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getBrowserClient, type TriggerView } from '../../lib/api';
import { expressionPaths } from '../../lib/samplePaths';

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      className="q-btn q-btn--ghost q-btn--sm"
      type="button"
      onClick={() => void navigator.clipboard?.writeText(value)?.catch(() => undefined)}
    >
      Copy {label}
    </button>
  );
}

interface TriggerPanelProps {
  workflowId: string;
  triggers: TriggerView[];
  showSecrets: boolean;
  loading?: boolean;
}

export function TriggerPanel({ workflowId, triggers, showSecrets, loading }: TriggerPanelProps) {
  if (loading) {
    return (
      <div className="q-trigger-panel" data-testid="trigger-panel">
        <span className="q-field__hint">Loading triggers…</span>
      </div>
    );
  }
  if (triggers.length === 0) return null;
  return (
    <div className="q-trigger-panel" data-testid="trigger-panel">
      <div className="q-inspector__section-title">Triggers</div>
      {triggers.map((t) => (
        <div key={t.nodeId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <strong className="mono">{t.nodeId}</strong>
          {t.type === 'webhook' ? (
            <>
              {/* The API omits the URLs for a member without workflow:activate — holding
                  them is enough to start a production run through the gateway. */}
              {t.url === undefined ? (
                <p className="q-field__hint" data-testid="trigger-url-hidden">
                  The endpoint URL is visible to members who can activate workflows.
                </p>
              ) : (
                <>
                  <div className="q-trigger-panel__url">
                    <code data-testid="trigger-url">{t.url}</code>
                    <CopyButton value={t.url} label="URL" />
                  </div>
                  <div className="q-trigger-panel__url">
                    <code data-testid="trigger-test-url">{t.testUrl}</code>
                    <CopyButton value={t.testUrl ?? ''} label="test URL" />
                  </div>
                </>
              )}
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
              {t.testUrl ? <SampleViewer workflowId={workflowId} nodeId={t.nodeId} testUrl={t.testUrl} /> : null}
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

/**
 * Payloads this trigger has actually received, and the expression paths into them.
 *
 * Only test-mode runs are recorded, so the empty state has to say how to produce one —
 * "no samples yet" beside a URL nobody told you to POST to is the support ticket this
 * feature would otherwise generate.
 */
function SampleViewer({ workflowId, nodeId, testUrl }: { workflowId: string; nodeId: string; testUrl: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['trigger-samples', workflowId, nodeId],
    queryFn: () => getBrowserClient().listTriggerSamples(workflowId, nodeId),
    enabled: open,
  });
  const samples = q.data?.samples ?? [];
  const first = samples[0];

  return (
    <details
      data-testid={`trigger-samples-${nodeId}`}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Sample payloads</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        {q.isPending && open ? <span className="q-field__hint">Loading…</span> : null}
        {q.isError ? <span className="q-field__error">Could not load samples.</span> : null}
        {q.data && samples.length === 0 ? (
          <span className="q-field__hint" data-testid={`trigger-samples-empty-${nodeId}`}>
            No sample payloads yet. POST to the test URL above and the body will appear here — production
            fires are not recorded as samples.
          </span>
        ) : null}
        {first !== undefined ? (
          <>
            <pre className="q-payload" data-testid={`trigger-sample-body-${nodeId}`}>
              {JSON.stringify(first, null, 2)}
            </pre>
            <div className="q-inspector__section-title">Paths you can paste</div>
            {expressionPaths(first).slice(0, 24).map((p) => (
              <div key={p.path} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <code className="mono" style={{ flex: 1 }}>{`{{ ${p.path} }}`}</code>
                <span className="q-field__hint">{p.preview}</span>
                <CopyButton value={`{{ ${p.path} }}`} label="path" />
              </div>
            ))}
          </>
        ) : null}
      </div>
    </details>
  );
}
