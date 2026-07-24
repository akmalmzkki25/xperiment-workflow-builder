'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Timeline } from '../../../../components/executions/Timeline';
import { StatusChip } from '../../../../components/ui/StatusChip';
import { getBrowserClient } from '../../../../lib/api';
import { fmtDuration, shortId } from '../../../../lib/format';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT']);

export default function ExecutionDetailPage({ params }: { params: { id: string } }) {
  const detailQ = useQuery({
    queryKey: ['execution', params.id],
    queryFn: () => getBrowserClient().getExecution(params.id),
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.execution.status) ? false : 2000,
  });

  if (detailQ.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading execution…</p>;
  if (detailQ.isError || !detailQ.data) return <div className="q-banner">Could not load this execution.</div>;

  const { execution } = detailQ.data;

  return (
    <>
      <div className="q-page-head">
        <h1 className="mono" style={{ fontSize: 'var(--text-h2)' }}>
          Run {shortId(execution.id)}
        </h1>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <StatusChip status={execution.status} testId="exec-status" />
          <span className="q-field__hint">{fmtDuration(execution.startedAt, execution.completedAt)}</span>
          <Link href={`/workflows/${execution.workflowId}`} className="q-btn q-btn--ghost q-btn--sm">
            Open workflow
          </Link>
        </div>
      </div>

      {execution.errorSummary ? <div className="q-banner">{execution.errorSummary}</div> : null}

      <Timeline detail={detailQ.data} />
    </>
  );
}
