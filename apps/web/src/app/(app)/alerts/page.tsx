'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NativeSelect } from '@/components/common/NativeSelect';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { PermissionNotice } from '../../../components/common/PermissionNotice';
import { getBrowserClient } from '../../../lib/api';
import type { AlertEvent, AlertRule } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

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
      <Input placeholder="Rule name" value={name} onChange={(e) => setName(e.target.value)} data-testid="alert-name" />
      <NativeSelect value={type} onChange={(e) => setType(e.target.value as typeof type)} data-testid="alert-type">
        <option value="failure_rate">Failure rate</option>
        <option value="usage_threshold">Usage threshold</option>
      </NativeSelect>
      <label className="text-[length:var(--text-small)] text-muted-foreground">
        Window (minutes)
        <Input type="number" min={1} value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))} />
      </label>
      {type === 'failure_rate' ? (
        <>
          <label className="text-[length:var(--text-small)] text-muted-foreground">
            Threshold (0–1)
            <Input type="number" step="0.05" min={0} max={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
          <label className="text-[length:var(--text-small)] text-muted-foreground">
            Minimum sample
            <Input type="number" min={1} value={minSample} onChange={(e) => setMinSample(Number(e.target.value))} />
          </label>
        </>
      ) : (
        <>
          <NativeSelect value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </NativeSelect>
          <label className="text-[length:var(--text-small)] text-muted-foreground">
            Threshold
            <Input type="number" min={0} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
        </>
      )}
      <Input placeholder="Webhook URL (optional)" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
      <Button size="sm" type="submit" disabled={create.isPending || !name.trim()} data-testid="alert-create">
        Create rule
      </Button>
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
    <TableRow data-testid={`alert-rule-${rule.id}`}>
      <TableCell>{rule.name}</TableCell>
      <TableCell className="mono" style={{ color: 'var(--text-muted)' }}>{rule.type}</TableCell>
      <TableCell>{rule.enabled ? 'On' : 'Off'}</TableCell>
      <TableCell style={{ color: 'var(--text-secondary)' }}>{rule.cooldownMinutes}m</TableCell>
      <TableCell style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button variant="ghost" size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
          {rule.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button variant="destructive" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Delete
        </Button>
      </TableCell>
    </TableRow>
  );
}

function FiringRow({ event }: { event: AlertEvent }) {
  const qc = useQueryClient();
  const ack = useMutation({
    mutationFn: () => getBrowserClient().acknowledgeAlert(event.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-events'] }),
  });
  return (
    <TableRow data-testid={`alert-event-${event.id}`}>
      <TableCell style={{ color: 'var(--text-secondary)' }}>{fmtTime(event.firedAt)}</TableCell>
      <TableCell className="mono" style={{ fontSize: 'var(--text-mono-sub)', color: 'var(--text-muted)' }}>{JSON.stringify(event.detail)}</TableCell>
      <TableCell>
        {event.acknowledgedAt ? (
          <span style={{ color: 'var(--text-muted)' }}>Acknowledged</span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => ack.mutate()} disabled={ack.isPending}>
            Acknowledge
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function AlertsPage() {
  const [secret, setSecret] = useState<string | null>(null);
  const rulesQ = useQuery({ queryKey: ['alert-rules'], queryFn: () => getBrowserClient().listAlerts(), retry: false });
  const eventsQ = useQuery({ queryKey: ['alert-events'], queryFn: () => getBrowserClient().listAlertEvents(), refetchInterval: 15000, retry: false });

  const forbidden = forbiddenDetail(rulesQ.error);
  if (forbidden) {
    return (
      <div data-testid="alerts-page">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1>Alerts</h1>
        </div>
        <PermissionNotice detail={forbidden} />
      </div>
    );
  }

  return (
    <div data-testid="alerts-page">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>Alerts</h1>
      </div>

      {secret ? (
        <Alert variant="warn" className="flex flex-wrap items-center gap-3" data-testid="alert-secret">
          Signing secret (shown once): <span className="mono">{secret}</span>
          <Button variant="ghost" size="sm"  style={{ marginLeft: 'var(--space-3)' }} onClick={() => setSecret(null)}>
            Dismiss
          </Button>
        </Alert>
      ) : null}

      <CreateRuleForm onCreated={(s) => s && setSecret(s)} />

      <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-3)' }}>Rules</h2>
      {(rulesQ.data?.items ?? []).length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No alert rules yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Cooldown</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{(rulesQ.data?.items ?? []).map((r) => <RuleRow key={r.id} rule={r} />)}</TableBody>
        </Table>
      )}

      <h2 style={{ fontSize: 'var(--text-h2)', margin: 'var(--space-6) 0 var(--space-3)' }}>Recent firings</h2>
      {(eventsQ.data?.items ?? []).length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No alerts have fired.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fired</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{(eventsQ.data?.items ?? []).map((e) => <FiringRow key={e.id} event={e} />)}</TableBody>
        </Table>
      )}
    </div>
  );
}
