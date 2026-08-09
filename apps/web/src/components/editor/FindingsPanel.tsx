'use client';

import { useReactFlow } from 'reactflow';
import type { Finding } from '../../lib/api';
import { isFocusable } from '../../lib/findings';
import { useEditorStore } from '../../stores/editorStore';

/**
 * Validation findings, each a way back to the node that caused it.
 *
 * Reads the React Flow instance and the selection store directly rather than taking
 * two more props: this renders inside ActionBar, which already carries seventeen and
 * has no business knowing how to fly a viewport.
 */
export function FindingsPanel({ findings }: { findings: Finding[] }) {
  const flow = useReactFlow();
  const select = useEditorStore((s) => s.select);
  if (findings.length === 0) return null;

  const focus = (nodeId: string) => {
    select(nodeId);
    void flow.fitView({ nodes: [{ id: nodeId }], padding: 0.6, maxZoom: 1.2, duration: 300 });
  };

  return (
    <div className="q-findings" data-testid="findings-panel">
      <div className="q-inspector__section-title">
        {findings.length} validation finding{findings.length > 1 ? 's' : ''}
      </div>
      {findings.map((f, index) => {
        const body = (
          <>
            <span className="q-findings__layer">{f.layer}</span>
            {f.nodeId ? <code>{f.nodeId}</code> : null}
            <span>{f.message}</span>
          </>
        );
        // A workflow-level finding — a missing entrypoint, a cycle — has nowhere to
        // fly to, so it stays plain text instead of a button that does nothing.
        return isFocusable(f) ? (
          <button
            type="button"
            className="q-findings__row q-findings__row--link"
            key={`${f.code}-${index}`}
            onClick={() => focus(f.nodeId)}
            title={`Show ${f.nodeId} on the canvas`}
            data-testid={`finding-${f.nodeId}`}
          >
            {body}
          </button>
        ) : (
          <div className="q-findings__row" key={`${f.code}-${index}`}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
