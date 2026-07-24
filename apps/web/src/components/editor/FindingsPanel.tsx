import type { Finding } from '../../lib/api';

export function FindingsPanel({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="q-findings" data-testid="findings-panel">
      <div className="q-inspector__section-title">
        {findings.length} validation finding{findings.length > 1 ? 's' : ''}
      </div>
      {findings.map((f, index) => (
        <div className="q-findings__row" key={`${f.code}-${index}`}>
          <span className="q-findings__layer">{f.layer}</span>
          {f.nodeId ? <code>{f.nodeId}</code> : null}
          <span>{f.message}</span>
        </div>
      ))}
    </div>
  );
}
