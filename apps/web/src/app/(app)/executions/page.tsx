'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PermissionNotice } from '../../../components/ui/PermissionNotice';
import { StatusChip } from '../../../components/ui/StatusChip';
import { getBrowserClient } from '../../../lib/api';
import { fmtDuration, fmtTime, shortId } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

const STATUS_FILTERS = ['ALL', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'];

function ExecutionsList() {
  const searchParams = useSearchParams();
  const workflowId = searchParams.get('workflowId') ?? undefined;
  const [statusFilter, setStatusFilter] = useState('ALL');

  const executions = useQuery({
    queryKey: ['executions', workflowId ?? ''],
    queryFn: () => getBrowserClient().listExecutions(workflowId ? { workflowId } : undefined),
    refetchInterval: 5000,
    retry: false,
  });

  const forbidden = forbiddenDetail(executions.error);
  const items = (executions.data?.items ?? []).filter(
    (e) => statusFilter === 'ALL' || e.status === statusFilter,
  );

  return (
    <>
      <div className="q-page-head">
        <h1>Executions</h1>
        <select
          className="q-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          data-testid="exec-filter"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === 'ALL' ? 'All statuses' : s}
            </option>
          ))}
        </select>
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : executions.isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading executions…</p>
      ) : items.length === 0 ? (
        <EmptyState title="No executions" hint="Runs appear here once a trigger fires or you execute a workflow." />
      ) : (
        <table className="q-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Created</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {items.map((exec) => (
              <tr key={exec.id} data-testid={`exec-row-${shortId(exec.id)}`}>
                <td>
                  <Link href={`/executions/${exec.id}`} className="q-table__rowlink mono">
                    {shortId(exec.id)}
                  </Link>
                </td>
                <td className="mono" style={{ color: 'var(--text-muted)' }}>
                  {shortId(exec.workflowId)}
                </td>
                <td>
                  <StatusChip status={exec.status} />
                </td>
                <td style={{ color: 'var(--text-secondary)' }}>{fmtTime(exec.createdAt)}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{fmtDuration(exec.startedAt, exec.completedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default function ExecutionsPage() {
  return (
    <Suspense fallback={<p style={{ color: 'var(--text-muted)' }}>Loading…</p>}>
      <ExecutionsList />
    </Suspense>
  );
}
