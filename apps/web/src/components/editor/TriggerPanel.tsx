'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { getBrowserClient, type TriggerView } from '../../lib/api';
import { deliveryHint, deliveryTone } from '../../lib/deliveryHint';
import { fmtTime } from '../../lib/format';
import { expressionPaths } from '../../lib/samplePaths';

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button variant="ghost" size="sm"
      
      type="button"
      onClick={() => void navigator.clipboard?.writeText(value)?.catch(() => undefined)}
    >
      Copy {label}
    </Button>
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
              <DeliveryViewer workflowId={workflowId} nodeId={t.nodeId} />
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

/**
 * What actually arrived at this endpoint, including what was turned away.
 *
 * Before this existed a rejected delivery produced a 401 and nothing else, so "my webhook
 * isn't working" had no evidence anywhere in the product. Fetched lazily behind a closed
 * `<details>`: unlike the trigger list this costs no audit row, but it is still a query
 * per editor mount that nobody asked for.
 */
function DeliveryViewer({ workflowId, nodeId }: { workflowId: string; nodeId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['trigger-deliveries', workflowId, nodeId],
    queryFn: () => getBrowserClient().listDeliveries(workflowId, nodeId),
    enabled: open,
    // A misconfigured sender retries; seeing the next attempt land without a manual
    // refresh is the difference between diagnosing in one sitting and two.
    refetchInterval: open ? 10_000 : false,
  });
  const items = q.data?.items ?? [];

  return (
    <details
      data-testid={`trigger-deliveries-${nodeId}`}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Recent deliveries</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        {q.isPending && open ? <span className="q-field__hint">Loading…</span> : null}
        {q.isError ? <span className="q-field__error">Could not load deliveries.</span> : null}
        {q.data && items.length === 0 ? (
          <span className="q-field__hint" data-testid={`trigger-deliveries-empty-${nodeId}`}>
            Nothing has reached this endpoint yet. Rejected deliveries appear here too, so if a provider says it
            is sending and this stays empty, the request is not arriving at all.
          </span>
        ) : null}
        {items.map((d) => (
          <div key={d.id} className="q-delivery" data-testid={`delivery-${d.id}`}>
            <span
              className="q-chip"
              style={{
                color:
                  deliveryTone(d.outcome) === 'succeeded'
                    ? 'var(--status-succeeded)'
                    : deliveryTone(d.outcome) === 'failed'
                      ? 'var(--status-failed)'
                      : 'var(--text-muted)',
              }}
            >
              {d.statusCode} {d.outcome}
            </span>
            <span className="q-field__hint">{fmtTime(d.receivedAt)}</span>
            <p className="q-delivery__hint">{deliveryHint(d)}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
