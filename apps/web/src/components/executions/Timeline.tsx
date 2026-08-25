import type { ExecutionDetail } from '../../lib/api';
import { fmtDuration, fmtTime, nodeLabel } from '../../lib/format';
import { attemptError, attemptPortLabel, groupAttemptsByNode } from '../../lib/timeline';
import { PayloadPanel } from '../common/PayloadPanel';
import { StatusChip } from '../common/StatusChip';
import { WaitsPanel } from './WaitsPanel';

export function Timeline({ detail }: { detail: ExecutionDetail }) {
  const groups = groupAttemptsByNode(detail.nodes);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {[...groups.entries()].map(([nodeId, attempts]) => (
        <div
          key={nodeId}
          className="q-trigger-panel"
          data-testid={`timeline-node-${nodeId}`}
          style={{ gap: 'var(--space-2)' }}
        >
          <strong className="mono">
            {nodeLabel(nodeId).text}
            {nodeLabel(nodeId).iteration !== null ? (
              <span className="q-field__hint" style={{ marginLeft: 'var(--space-2)' }}>
                iteration {nodeLabel(nodeId).iteration}
              </span>
            ) : null}
          </strong>
          {attempts.map((attempt) => {
            const error = attemptError(attempt.errorJson);
            const port = attemptPortLabel(attempt.outputPort);
            return (
              <div
                key={attempt.attempt}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}
              >
                <span className="q-field__hint mono">#{attempt.attempt}</span>
                <StatusChip status={attempt.status} testId={`timeline-status-${nodeId}-${attempt.attempt}`} />
                <span className="q-field__hint">{fmtDuration(attempt.startedAt, attempt.completedAt)}</span>
                {port ? <span className="q-field__hint mono">→ {port}</span> : null}
                {error ? <span className="q-field__error">{error}</span> : null}
                {detail.payloadsVisible ? (
                  <div style={{ width: '100%', marginTop: 'var(--space-1)' }}>
                    <PayloadPanel
                      executionId={detail.execution.id}
                      nodeId={attempt.nodeId}
                      attempt={attempt.attempt}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}

      {!detail.payloadsVisible ? (
        <span className="q-field__hint" data-testid="payloads-hidden">
          Node data is shown to members who can run workflows.
        </span>
      ) : null}

      <WaitsPanel waits={detail.waits} />

      <div className="q-trigger-panel" style={{ gap: 'var(--space-1)' }}>
        <div className="q-inspector__section-title">Event log</div>
        {detail.events.map((event) => (
          <div key={event.sequence} className="mono" style={{ fontSize: 'var(--text-mono)', color: 'var(--text-secondary)' }}>
            {String(event.sequence).padStart(3, '0')} · {fmtTime(event.createdAt)} · {event.eventType}
            {event.nodeId ? ` · ${event.nodeId}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
