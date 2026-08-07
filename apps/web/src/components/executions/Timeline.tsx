import type { ExecutionDetail, ExecutionNodeRow } from '../../lib/api';
import { fmtDuration, fmtTime, nodeLabel } from '../../lib/format';
import { StatusChip } from '../ui/StatusChip';

function groupByNode(nodes: ExecutionNodeRow[]): Map<string, ExecutionNodeRow[]> {
  const map = new Map<string, ExecutionNodeRow[]>();
  for (const row of nodes) {
    map.set(row.nodeId, [...(map.get(row.nodeId) ?? []), row]);
  }
  return map;
}

function errorMessage(errorJson: unknown): string | null {
  if (typeof errorJson !== 'object' || errorJson === null) return null;
  const e = errorJson as { message?: string; code?: string };
  if (!e.message && !e.code) return null;
  return [e.code, e.message].filter(Boolean).join(': ');
}

export function Timeline({ detail }: { detail: ExecutionDetail }) {
  const groups = groupByNode(detail.nodes);
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
            const error = errorMessage(attempt.errorJson);
            return (
              <div
                key={attempt.attempt}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}
              >
                <span className="q-field__hint mono">#{attempt.attempt}</span>
                <StatusChip status={attempt.status} testId={`timeline-status-${nodeId}-${attempt.attempt}`} />
                <span className="q-field__hint">{fmtDuration(attempt.startedAt, attempt.completedAt)}</span>
                {attempt.outputPort && attempt.outputPort !== 'main' ? (
                  <span className="q-field__hint mono">→ {attempt.outputPort}</span>
                ) : null}
                {error ? <span className="q-field__error">{error}</span> : null}
              </div>
            );
          })}
        </div>
      ))}

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
