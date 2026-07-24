'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getBrowserClient } from '../../../lib/api';
import type { AlertEvent, AlertRule } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';

const METRICS = ['execution', 'node', 'compute_ms', 'ai_tokens'] as const;

function CreateRuleForm({ onCreated }: { onCreated: (secret?: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'failure_rate' | 'usage_threshold'>('failure_rate');
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [threshold, setThreshold] = useState(0.5);
  const [minSample, setMinSample] = useState(5);
  const [metric, setMetric] = useState<(typeof METRICS)[number]>('ai_tokens');
  const [webhookUrl, setWebhookUrl] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const params =
        type === 'failure_rate'
          ? { windowMinutes, threshold, minSample }
          : { windowMinutes, metric, threshold };
      return getBrowserClient().createAlert({
        name,
        type,
        params,
        ...(webhookUrl ? { webhookUrl } : {}),
      });
    },
    onSuccess: (rule) => {
      setName('');
      setWebhookUrl('');
      void qc.invalidateQueries({ queryKey: ['alert-rules'] });
      onCreated(rule.secret);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
      style={{
        display: 'grid',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-node)',
        marginBottom: 'var(--space-6)',
        maxWidth: 640,
      }}
    >
      <input className="q-input" placeholder="Rule name" value={name} onChange={(e) => setName(e.target.value)} data-testid="alert-name" />
      <select className="q-select" value={type} onChange={(e) => setType(e.target.value as typeof type)} data-testid="alert-type">
        <option value="failure_rate">Failure rate</option>
        <option value="usage_threshold">Usage threshold</option>
      </select>
      <label className="q-field__hint">
        Window (minutes)
        <input className="q-input" type="number" min={1} value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))} />
      </label>
      {type === 'failure_rate' ? (
        <>
          <label className="q-field__hint">
            Threshold (0–1)
            <input className="q-input" type="number" step="0.05" min={0} max={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
          <label className="q-field__hint">
            Minimum sample
            <input className="q-input" type="number" min={1} value={minSample} onChange={(e) => setMinSample(Number(e.target.value))} />
          </label>
        </>
      ) : (
        <>
          <select className="q-select" value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <label className="q-field__hint">
            Threshold
            <input className="q-input" type="number" min={0} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
        </>
      )}
      <input className="q-input" placeholder="Webhook URL (optional)" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
      <button className="q-btn q-btn--primary q-btn--sm" type="submit" disabled={create.isPending || !name.trim()} data-testid="alert-create">
        Create rule
      </button>
    </form>
  );
}

function RuleRow({ rule }: { rule: AlertRule }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => getBrowserClient().updateAlert(rule.id, { enabled: !rule.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
  });
  const remove = useMutation({
    mutationFn: () => getBrowserClient().deleteAlert(rule.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
  });
  return (
    <tr data-testid={`alert-rule-${rule.id}`}>
      <td>{rule.name}</td>
      <td className="mono" style={{ color: 'var(--text-muted)' }}>{rule.type}</td>
      <td>{rule.enabled ? 'On' : 'Off'}</td>
      <td style={{ color: 'var(--text-secondary)' }}>{rule.cooldownMinutes}m</td>
      <td style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button className="q-btn q-btn--ghost q-btn--sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
          {rule.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="q-btn q-btn--danger q-btn--sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Delete
        </button>
      </td>
    </tr>
  );
}

function FiringRow({ event }: { event: AlertEvent }) {
  const qc = useQueryClient();
  const ack = useMutation({
    mutationFn: () => getBrowserClient().acknowledgeAlert(event.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-events'] }),
  });
  return (
    <tr data-testid={`alert-event-${event.id}`}>
      <td style={{ color: 'var(--text-secondary)' }}>{fmtTime(event.firedAt)}</td>
      <td className="mono" style={{ fontSize: 'var(--text-mono-sub)', color: 'var(--text-muted)' }}>{JSON.stringify(event.detail)}</td>
      <td>
        {event.acknowledgedAt ? (
          <span style={{ color: 'var(--text-muted)' }}>Acknowledged</span>
        ) : (
          <button className="q-btn q-btn--ghost q-btn--sm" onClick={() => ack.mutate()} disabled={ack.isPending}>
            Acknowledge
          </button>
        )}
      </td>
    </tr>
  );
}

export default function AlertsPage() {
  const [secret, setSecret] = useState<string | null>(null);
  const rulesQ = useQuery({ queryKey: ['alert-rules'], queryFn: () => getBrowserClient().listAlerts() });
  const eventsQ = useQuery({ queryKey: ['alert-events'], queryFn: () => getBrowserClient().listAlertEvents(), refetchInterval: 15000 });

  return (
    <div data-testid="alerts-page">
      <div className="q-page-head">
        <h1>Alerts</h1>
      </div>

      {secret ? (
        <div className="q-banner q-banner--warn" data-testid="alert-secret">
          Signing secret (shown once): <span className="mono">{secret}</span>
          <button className="q-btn q-btn--ghost q-btn--sm" style={{ marginLeft: 'var(--space-3)' }} onClick={() => setSecret(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <CreateRuleForm onCreated={(s) => s && setSecret(s)} />

      <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-3)' }}>Rules</h2>
      {(rulesQ.data?.items ?? []).length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No alert rules yet.</p>
      ) : (
        <table className="q-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Enabled</th>
              <th>Cooldown</th>
              <th></th>
            </tr>
          </thead>
          <tbody>{(rulesQ.data?.items ?? []).map((r) => <RuleRow key={r.id} rule={r} />)}</tbody>
        </table>
      )}

      <h2 style={{ fontSize: 'var(--text-h2)', margin: 'var(--space-6) 0 var(--space-3)' }}>Recent firings</h2>
      {(eventsQ.data?.items ?? []).length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No alerts have fired.</p>
      ) : (
        <table className="q-table">
          <thead>
            <tr>
              <th>Fired</th>
              <th>Detail</th>
              <th></th>
            </tr>
          </thead>
          <tbody>{(eventsQ.data?.items ?? []).map((e) => <FiringRow key={e.id} event={e} />)}</tbody>
        </table>
      )}
    </div>
  );
}
