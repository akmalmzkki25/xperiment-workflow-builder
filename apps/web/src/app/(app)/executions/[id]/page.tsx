'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Timeline } from '../../../../components/executions/Timeline';
import { StatusChip } from '../../../../components/common/StatusChip';
import { getBrowserClient } from '../../../../lib/api';
import { fmtDuration, shortId } from '../../../../lib/format';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED']);

export default function ExecutionDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const detailQ = useQuery({
    queryKey: ['execution', params.id],
    queryFn: () => getBrowserClient().getExecution(params.id),
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.execution.status) ? false : 2000,
  });

  const cancel = useMutation({
    mutationFn: () => getBrowserClient().cancelExecution(params.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['execution', params.id] }),
  });
  const retry = useMutation({
    mutationFn: () => getBrowserClient().retryExecution(params.id),
    onSuccess: ({ executionId }) => router.push(`/executions/${executionId}`),
  });

  if (detailQ.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading execution…</p>;
  if (detailQ.isError || !detailQ.data) return <Alert className="flex flex-wrap items-center gap-3">Could not load this execution.</Alert>;

  const { execution } = detailQ.data;
  const isTerminal = TERMINAL.has(execution.status);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="mono" style={{ fontSize: 'var(--text-h2)' }}>
          Run {shortId(execution.id)}
        </h1>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <StatusChip status={execution.status} testId="exec-status" />
          <span className="text-[length:var(--text-small)] text-muted-foreground">{fmtDuration(execution.startedAt, execution.completedAt)}</span>
          {!isTerminal ? (
            <Button variant="destructive" size="sm"
              
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
              data-testid="exec-cancel"
            >
              Cancel
            </Button>
          ) : null}
          <Button variant="ghost" size="sm"
            
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
            data-testid="exec-retry"
          >
            Retry
          </Button>
          <Button asChild variant="ghost" size="sm"><Link href={`/workflows/${execution.workflowId}`}>
            Open workflow
          </Link></Button>
        </div>
      </div>

      {execution.errorSummary ? <Alert className="flex flex-wrap items-center gap-3">{execution.errorSummary}</Alert> : null}

      <Timeline detail={detailQ.data} />
    </>
  );
}
