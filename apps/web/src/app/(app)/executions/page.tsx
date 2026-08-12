'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PermissionNotice } from '../../../components/ui/PermissionNotice';
import { StatusChip } from '../../../components/ui/StatusChip';
import { getBrowserClient } from '../../../lib/api';
import { choiceFromParams, paramsForChoice, statusesFor, STATUS_CHOICES } from '../../../lib/executionFilter';
import { fmtDuration, fmtTime, shortId } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

function ExecutionsList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workflowId = searchParams.get('workflowId') ?? undefined;
  // The filter lives in the URL, so a filtered view is a link somebody can send.
  const choice = choiceFromParams(searchParams.get('status'));
  const statuses = statusesFor(choice);
  // Cursors are a stack so Back can go back. Reset whenever the filter changes: a cursor
  // minted under one filter is rejected by the server under another, on purpose.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];

  const executions = useQuery({
    queryKey: ['executions', workflowId ?? '', choice, cursor ?? ''],
    queryFn: () =>
      getBrowserClient().listExecutions({
        ...(workflowId ? { workflowId } : {}),
        ...(statuses ? { status: statuses } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    // Only the first page polls. A page of history should not reshuffle under someone
    // who is reading it.
    refetchInterval: cursor === undefined ? 5000 : false,
    retry: false,
  });

  const forbidden = forbiddenDetail(executions.error);
  const items = executions.data?.items ?? [];
  const nextCursor = executions.data?.nextCursor ?? null;

  const queryClient = useQueryClient();
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  // The filter the operator is already looking at IS the retry filter. Asking them to
  // restate it in a dialog would be a second chance to get it wrong.
  const retry = useMutation({
    mutationFn: (dryRun: boolean) =>
      getBrowserClient().bulkRetry({
        ...(workflowId ? { workflowId } : {}),
        ...(statuses ? { status: statuses } : {}),
        dryRun,
      }),
    onSuccess: (r) => {
      if (r.dryRun) {
        setRetryNotice(
          r.matched === 0
            ? 'Nothing matches this filter, so there is nothing to re-run.'
            : `${r.matched} run(s) match. Re-run them?`,
        );
        return;
      }
      setRetryNotice(
        r.stoppedForQuota
          ? `Re-ran ${r.retried} of ${r.matched} and stopped: the workspace hit its execution limit.`
          : `Re-ran ${r.retried} run(s)${r.skipped > 0 ? `, skipped ${r.skipped} whose version is gone` : ''}.`,
      );
      setCursors([]);
      void queryClient.invalidateQueries({ queryKey: ['executions'] });
    },
    onError: (e) => setRetryNotice(e instanceof Error ? e.message : 'Bulk retry failed'),
  });
  // Re-running successes duplicates work that already happened, so the button is only
  // offered on a filter that selects failures.
  const canBulkRetry = choice === 'PROBLEMS' || choice === 'FAILED' || choice === 'TIMED_OUT';

  const setChoice = (next: string): void => {
    setCursors([]);
    router.replace(`/executions${paramsForChoice(next, workflowId)}`);
  };

  return (
    <>
      <div className="q-page-head">
        <h1>Executions</h1>
        <select
          className="q-select"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          aria-label="Filter by status"
          data-testid="exec-filter"
        >
          {STATUS_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {canBulkRetry && !forbidden ? (
        <div className="q-banner" data-testid="bulk-retry-bar">
          <span>{retryNotice ?? 'Fixed whatever broke these? Re-run them all.'}</span>
          <button
            className="q-btn q-btn--ghost q-btn--sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate(true)}
            data-testid="bulk-retry-count"
          >
            Count matches
          </button>
          <button
            className="q-btn q-btn--sm"
            disabled={retry.isPending}
            onClick={() => {
              if (window.confirm('Re-run every execution matching this filter? Each one uses quota.')) {
                retry.mutate(false);
              }
            }}
            data-testid="bulk-retry-run"
          >
            Re-run matching
          </button>
        </div>
      ) : null}

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : executions.isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading executions…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No executions"
          hint={
            choice === 'ALL'
              ? 'Runs appear here once a trigger fires or you execute a workflow.'
              : 'No runs match this filter. The whole history was searched, not just the first page.'
          }
        />
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

      {forbidden || items.length === 0 ? null : (
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
          <button
            className="q-btn q-btn--ghost q-btn--sm"
            disabled={cursors.length === 0}
            onClick={() => setCursors((prev) => prev.slice(0, -1))}
            data-testid="exec-prev"
          >
            Previous
          </button>
          <button
            className="q-btn q-btn--ghost q-btn--sm"
            disabled={nextCursor === null}
            onClick={() => setCursors((prev) => (nextCursor ? [...prev, nextCursor] : prev))}
            data-testid="exec-next"
          >
            Next
          </button>
          {cursors.length > 0 ? (
            <span style={{ alignSelf: 'center', color: 'var(--text-muted)' }}>
              Page {cursors.length + 1} — live updates paused
            </span>
          ) : null}
        </div>
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
