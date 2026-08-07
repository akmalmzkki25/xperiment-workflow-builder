'use client';

import { Handle, Position, type NodeProps } from 'reactflow';
import type { IRNodeData } from '../../lib/irCanvas';
import { useEditorContext } from './EditorContext';

const DEFAULT_CONCURRENCY = 1;

/**
 * A loop draws as a frame its body nodes sit inside, rather than as one more box in the
 * chain. React Flow parents the body nodes to this one, so dropping a node in or dragging it
 * out is what sets or clears its `scope` — see `canvasToDefinition`.
 *
 * Two source handles: `item` on the inside edge, feeding the body, and `done` on the outside,
 * carrying the run onward once every iteration has finished.
 */
export function XperimentLoopNode({ data, selected }: NodeProps<{ ir: IRNodeData }>) {
  const { findingsByNode } = useEditorContext();
  const ir = data.ir;
  const findings = findingsByNode.get(ir.id) ?? [];
  const params = ir.parameters as { concurrency?: unknown; maxIterations?: unknown };
  const concurrency = typeof params.concurrency === 'number' ? params.concurrency : DEFAULT_CONCURRENCY;

  return (
    <div className={selected ? 'q-loop q-loop--selected' : 'q-loop'} data-testid={`node-${ir.id}`}>
      <Handle type="target" id="input" position={Position.Left} style={{ top: 28 }} />
      <div className="q-loop__head">
        <span className="q-loop__glyph" aria-hidden>
          ↻
        </span>
        <span className="q-loop__title">{ir.id}</span>
        <span className="q-loop__meta">
          {concurrency === 1 ? 'one at a time' : `${concurrency} at a time`}
        </span>
      </div>
      {findings.length > 0 ? (
        <span className="q-node__badge q-node__badge--findings" data-testid={`findings-badge-${ir.id}`}>
          {findings.length} issue{findings.length > 1 ? 's' : ''}
        </span>
      ) : null}
      <p className="q-loop__hint">Drop the nodes to repeat inside this frame.</p>
      <Handle type="source" id="item" position={Position.Left} style={{ top: 72 }} />
      <span className="q-loop__port-label q-loop__port-label--item">item</span>
      <Handle type="source" id="done" position={Position.Right} style={{ top: 28 }} />
      <span className="q-loop__port-label q-loop__port-label--done">done</span>
    </div>
  );
}
