'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ExecutionDetail } from '../../lib/api';
import { fmtDuration, shortId } from '../../lib/format';
import { StatusChip } from '../common/StatusChip';

interface Props {
  executionId: string;
  detail: ExecutionDetail | undefined;
  watchExpired: boolean;
  onStopWatching: () => void;
}

export function RunBanner({ executionId, detail, watchExpired, onStopWatching }: Props) {
  return (
    <Alert className="flex flex-wrap items-center gap-3" data-testid="run-banner">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <span className="mono">run {shortId(executionId)}</span>
        {detail ? <StatusChip status={detail.execution.status} testId="run-status" /> : <span>starting…</span>}
        {detail ? (
          <span className="text-[length:var(--text-small)] text-muted-foreground">{fmtDuration(detail.execution.startedAt, detail.execution.completedAt)}</span>
        ) : null}
        <Button asChild variant="ghost"><Link href={`/executions/${executionId}`}  data-testid="run-open">
          Open run →
        </Link></Button>
        <Button variant="ghost" type="button" onClick={onStopWatching} data-testid="run-stop-watching">
          Stop watching
        </Button>
      </div>
      {watchExpired ? (
        <span className="text-[length:var(--text-small)] text-muted-foreground">
          Stopped watching after ten minutes — this run is waiting on something. Open it to see what.
        </span>
      ) : null}
    </Alert>
  );
}
