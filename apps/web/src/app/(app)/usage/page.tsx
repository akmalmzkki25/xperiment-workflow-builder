'use client';

import { useQuery } from '@tanstack/react-query';
import { PermissionNotice } from '../../../components/ui/PermissionNotice';
import { getBrowserClient } from '../../../lib/api';
import type { UsageSummary } from '../../../lib/api';
import { fmtCount, fmtMs } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

type Scorecard = { label: string; value: string; hint?: string; testId: string };

function scorecards(u: UsageSummary): Scorecard[] {
  const { totals } = u;
  const rate = totals.executions > 0 ? Math.round((totals.succeeded / totals.executions) * 100) : null;
  return [
    { label: 'Runs', value: fmtCount(totals.executions), hint: `${fmtCount(totals.failed)} failed`, testId: 'usage-runs' },
    { label: 'Success rate', value: rate === null ? '—' : `${rate}%`, testId: 'usage-success' },
    { label: 'Nodes run', value: fmtCount(totals.nodes), testId: 'usage-nodes' },
    { label: 'Compute', value: fmtMs(totals.computeMs), testId: 'usage-compute' },
    { label: 'AI tokens', value: fmtCount(totals.aiTokens), testId: 'usage-tokens' },
  ];
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function UsageChart({ series }: { series: UsageSummary['series'] }) {
  if (series.length === 0) {
    return <p style={{ color: 'var(--text-muted)' }}>No runs in this period yet.</p>;
  }
  const max = Math.max(1, ...series.map((d) => d.executions));
  return (
    <div
      aria-label="Runs per day"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 'var(--space-2)',
        height: 180,
        padding: 'var(--space-4)',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-node)',
        overflowX: 'auto',
      }}
    >
      {series.map((d) => (
        <div
          key={d.date}
          title={`${fmtDay(d.date)}: ${d.executions} run${d.executions === 1 ? '' : 's'}`}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-1)', minWidth: 28, flex: 1 }}
        >
          <div
            data-testid={`usage-bar-${d.date}`}
            style={{
              width: '100%',
              maxWidth: 40,
              height: `${Math.max(2, (d.executions / max) * 130)}px`,
              background: 'var(--status-running)',
              borderRadius: 'var(--radius-chip)',
              transition: 'filter var(--duration-fast) var(--ease-out)',
            }}
          />
          <span className="mono" style={{ fontSize: 'var(--text-mono-sub)', color: 'var(--text-muted)' }}>
            {fmtDay(d.date)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function UsagePage() {
  const usageQ = useQuery({
    queryKey: ['usage'],
    queryFn: () => getBrowserClient().getUsage(),
    retry: false,
  });

  const forbidden = forbiddenDetail(usageQ.error);
  if (forbidden) return <PermissionNotice detail={forbidden} />;
  if (usageQ.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading usage…</p>;
  if (usageQ.isError || !usageQ.data) return <div className="q-banner">Could not load usage.</div>;

  const usage = usageQ.data;
  const periodFrom = new Date(usage.period.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div data-testid="usage-page">
      <div className="q-page-head">
        <h1>Usage</h1>
        <span className="q-field__hint">Since {periodFrom} · this workspace</span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-6)',
        }}
      >
        {scorecards(usage).map((c) => (
          <div
            key={c.testId}
            data-testid={c.testId}
            style={{
              padding: 'var(--space-4)',
              background: 'var(--surface-raised)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-node)',
            }}
          >
            <div style={{ fontSize: 'var(--text-small)', color: 'var(--text-muted)', marginBottom: 'var(--space-1)' }}>
              {c.label}
            </div>
            <div className="mono" style={{ fontSize: 'var(--text-h2)', color: 'var(--text-primary)' }}>
              {c.value}
            </div>
            {c.hint ? (
              <div style={{ fontSize: 'var(--text-small)', color: 'var(--text-secondary)', marginTop: 'var(--space-1)' }}>
                {c.hint}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-3)' }}>Runs per day</h2>
      <UsageChart series={usage.series} />
    </div>
  );
}
