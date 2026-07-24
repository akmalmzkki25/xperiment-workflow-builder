'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { getBrowserClient } from '../../../../../lib/api';
import type { WorkflowDiff } from '../../../../../lib/api';
import { fmtTime, shortId } from '../../../../../lib/format';

function DiffList({ label, ids, color }: { label: string; ids: string[]; color: string }) {
  if (ids.length === 0) return null;
  return (
    <div style={{ marginBottom: 'var(--space-2)' }}>
      <span style={{ color, fontWeight: 600 }}>{label}</span>{' '}
      <span className="mono" style={{ color: 'var(--text-secondary)' }}>{ids.join(', ')}</span>
    </div>
  );
}

function DiffView({ diff }: { diff: WorkflowDiff }) {
  if (!diff.changed) return <p style={{ color: 'var(--text-muted)' }}>No changes between these versions.</p>;
  return (
    <div data-testid="diff-result" style={{ padding: 'var(--space-4)', background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-node)' }}>
      <h3 style={{ fontSize: 'var(--text-body)', marginBottom: 'var(--space-2)' }}>Nodes</h3>
      <DiffList label="+ Added" ids={diff.nodes.added} color="var(--status-succeeded)" />
      <DiffList label="− Removed" ids={diff.nodes.removed} color="var(--status-failed)" />
      {diff.nodes.modified.map((m) => (
        <div key={m.nodeId} style={{ marginBottom: 'var(--space-2)' }}>
          <span style={{ color: 'var(--color-amber)', fontWeight: 600 }}>~ Modified</span>{' '}
          <span className="mono">{m.nodeId}</span>{' '}
          {m.changedFields.map((f) => (
            <span key={f} className="q-chip" style={{ marginLeft: 4 }}>{f}</span>
          ))}
        </div>
      ))}
      <h3 style={{ fontSize: 'var(--text-body)', margin: 'var(--space-3) 0 var(--space-2)' }}>Edges</h3>
      <DiffList label="+ Added" ids={diff.edges.added} color="var(--status-succeeded)" />
      <DiffList label="− Removed" ids={diff.edges.removed} color="var(--status-failed)" />
      <DiffList label="~ Rewired" ids={diff.edges.modified.map((m) => m.edgeId)} color="var(--color-amber)" />
    </div>
  );
}

export default function VersionsPage({ params }: { params: { id: string } }) {
  const qc = useQueryClient();
  const wfQ = useQuery({ queryKey: ['workflow', params.id], queryFn: () => getBrowserClient().getWorkflow(params.id) });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<{ from: string; to: string; diff: WorkflowDiff } | null>(null);

  const compare = useMutation({
    mutationFn: () => getBrowserClient().getDiff(params.id, from, to),
    onSuccess: (d) => setDiff(d),
  });
  const rollback = useMutation({
    mutationFn: (versionId: string) => getBrowserClient().rollbackVersion(params.id, versionId),
    onSuccess: () => {
      setDiff(null);
      void qc.invalidateQueries({ queryKey: ['workflow', params.id] });
    },
  });

  if (wfQ.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading versions…</p>;
  if (wfQ.isError || !wfQ.data) return <div className="q-banner">Could not load this workflow.</div>;

  const wf = wfQ.data;
  const options = [
    ...(wf.draft ? [{ value: 'draft', label: 'Draft' }] : []),
    ...wf.versions.map((v) => ({ value: v.id, label: `v${v.versionNumber}` })),
  ];

  return (
    <div data-testid="versions-page">
      <div className="q-page-head">
        <h1>Versions · {shortId(params.id)}</h1>
        <Link href={`/workflows/${params.id}`} className="q-btn q-btn--ghost q-btn--sm">Open editor</Link>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        <select className="q-select" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="diff-from" aria-label="Compare from">
          <option value="">From…</option>
          {options.map((o) => <option key={`f-${o.value}`} value={o.value}>{o.label}</option>)}
        </select>
        <span style={{ color: 'var(--text-muted)' }}>→</span>
        <select className="q-select" value={to} onChange={(e) => setTo(e.target.value)} data-testid="diff-to" aria-label="Compare to">
          <option value="">To…</option>
          {options.map((o) => <option key={`t-${o.value}`} value={o.value}>{o.label}</option>)}
        </select>
        <button className="q-btn q-btn--primary q-btn--sm" disabled={!from || !to || compare.isPending} onClick={() => compare.mutate()} data-testid="diff-compare">
          Compare
        </button>
      </div>

      {diff ? <div style={{ marginBottom: 'var(--space-6)' }}><DiffView diff={diff.diff} /></div> : null}

      {wf.versions.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No published versions yet.</p>
      ) : (
        <table className="q-table">
          <thead>
            <tr><th>Version</th><th>Published</th><th>Hash</th><th></th></tr>
          </thead>
          <tbody>
            {wf.versions.map((v) => (
              <tr key={v.id} data-testid={`version-${v.versionNumber}`}>
                <td>
                  v{v.versionNumber}
                  {v.id === wf.activeVersionId ? <span className="q-chip" style={{ marginLeft: 6 }}>active</span> : null}
                </td>
                <td style={{ color: 'var(--text-secondary)' }}>{fmtTime(v.publishedAt)}</td>
                <td className="mono" style={{ color: 'var(--text-muted)' }}>{shortId(v.definitionHash)}</td>
                <td>
                  <button
                    className="q-btn q-btn--ghost q-btn--sm"
                    disabled={rollback.isPending || v.id === wf.activeVersionId}
                    onClick={() => {
                      if (window.confirm(`Roll back to v${v.versionNumber}? This publishes it forward as a new version.`)) rollback.mutate(v.id);
                    }}
                    data-testid={`rollback-${v.versionNumber}`}
                  >
                    Rollback
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
