'use client';

import type { ExecutionWaitRow } from '../../lib/api';
import { Alert } from '@/components/ui/alert';
import { fmtJakarta } from '../../lib/format';
import { waitDecisionLine, waitKindLabel } from '../../lib/waitLabel';
import { StatusChip } from '../common/StatusChip';

/**
 * Why a run is sitting still.
 *
 * The API already computes this and attaches a resumeUrl for open event waits; the
 * timeline used to fetch it and throw it away, which made the whole durable-suspend
 * feature invisible — a run parked for two days showed a grey chip and nothing else.
 */
export function WaitsPanel({ waits }: { waits: ExecutionWaitRow[] }) {
  if (waits.length === 0) return null;
  return (
    <div className="q-trigger-panel" style={{ gap: 'var(--space-3)' }} data-testid="execution-waits">
      <div className="text-[length:var(--text-small)] font-medium uppercase tracking-[0.05em] text-muted-foreground">Waits</div>
      {waits.map((wait) => (
        <div
          key={`${wait.nodeId}:${wait.kind}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
          data-testid={`wait-${wait.nodeId}`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <span className="mono">{wait.nodeId}</span>
            <StatusChip status={wait.status} />
            <span className="text-[length:var(--text-small)] text-muted-foreground">{waitKindLabel(wait.kind)}</span>
          </div>
          {wait.expiresAt ? (
            // Absolute Jakarta wall time, not "in 2 hours" off an arbitrary browser
            // clock — a viewer in another timezone would otherwise read it wrong.
            <span className="text-[length:var(--text-small)] text-muted-foreground">Expires {fmtJakarta(wait.expiresAt)}</span>
          ) : null}
          {waitDecisionLine(wait.decision, wait.resolvedBy) ? (
            <span className="text-[length:var(--text-small)] text-muted-foreground">{waitDecisionLine(wait.decision, wait.resolvedBy)}</span>
          ) : null}
          {wait.resumeUrl ? (
            <Alert variant="warn" className="flex flex-wrap items-center gap-3" data-testid={`wait-resume-${wait.nodeId}`}>
              This resume URL <strong>is</strong> the credential — anyone holding it can continue the run. Treat it
              like a password.
              <div className="mono" style={{ wordBreak: 'break-all', marginTop: 'var(--space-1)' }}>
                {wait.resumeUrl}
              </div>
            </Alert>
          ) : null}
        </div>
      ))}
    </div>
  );
}
