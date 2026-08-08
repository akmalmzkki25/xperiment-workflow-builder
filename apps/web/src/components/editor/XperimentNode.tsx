'use client';

import { useMemo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import type { IRNodeData } from '../../lib/irCanvas';
import { deriveFields, nodeReadiness, type NodeReadiness } from '../../lib/schemaForm';
import { useEditorContext } from './EditorContext';

export const NODE_GLYPHS: Record<string, string> = {
  'manual.trigger': '▷',
  'webhook.trigger': '⚡',
  'schedule.trigger': '⏰',
  'core.transform': 'ƒ',
  'core.if': '⑂',
  'http.request': '⇄',
  'postgres.query': '▤',
  'telegram.sendMessage': '✈',
  'openai.chat': '✦',
  'gemini.generate': '✦',
};

const READINESS_LABEL: Record<NodeReadiness, string> = {
  ready: 'Ready',
  'needs-config': 'Needs config',
  'needs-connection': 'Needs connection',
};

export function XperimentNode({ data, selected }: NodeProps<{ ir: IRNodeData }>) {
  const { catalogByType, findingsByNode, runStatusByNode } = useEditorContext();
  const ir = data.ir;
  const item = catalogByType.get(ir.type);
  const fields = useMemo(() => (item ? deriveFields(item.paramsJsonSchema) : []), [item]);
  const readiness = nodeReadiness({
    parameters: ir.parameters,
    fields,
    ...(item?.requiresConnection ? { requiresConnection: item.requiresConnection } : {}),
    ...(ir.connectionRef ? { connectionRef: ir.connectionRef } : {}),
  });
  const findings = findingsByNode.get(ir.id) ?? [];
  const outputPorts = item?.outputPorts ?? ['main'];
  const multiPort = outputPorts.length > 1;

  return (
    <div
      className={selected ? 'q-node q-node--selected' : 'q-node'}
      data-testid={`node-${ir.id}`}
      // A data attribute rather than a class: CSS owns the palette, and this never
      // reaches node.data.ir, so it cannot be persisted into the saved definition.
      data-run={runStatusByNode.get(ir.id)}
    >
      <span className="q-node__rail" style={{ background: `var(--rail-${ir.kind})` }} />
      {ir.kind !== 'trigger' ? (
        <Handle type="target" id="input" position={Position.Left} style={{ top: '50%' }} />
      ) : null}
      <div className="q-node__head">
        <span className="q-node__glyph" aria-hidden>
          {NODE_GLYPHS[ir.type] ?? '▣'}
        </span>
        <span className="q-node__title">{ir.id}</span>
      </div>
      <span className="q-node__sub">
        {ir.type} · v{ir.operationVersion}
      </span>
      <div className="q-node__badges">
        <span className={`q-node__badge q-node__badge--${readiness}`} data-testid={`readiness-${ir.id}`}>
          {READINESS_LABEL[readiness]}
        </span>
        {findings.length > 0 ? (
          <span className="q-node__badge q-node__badge--findings" data-testid={`findings-badge-${ir.id}`}>
            {findings.length} issue{findings.length > 1 ? 's' : ''}
          </span>
        ) : null}
      </div>
      {outputPorts.map((port, index) => {
        const top = multiPort ? `${((index + 1) / (outputPorts.length + 1)) * 100}%` : '50%';
        return (
          <span key={port}>
            <Handle type="source" id={port} position={Position.Right} style={{ top }} />
            {multiPort ? (
              <span className="q-node__port-label" style={{ top: `calc(${top} - 7px)` }}>
                {port}
              </span>
            ) : null}
          </span>
        );
      })}
      {/* `error` is offered implicitly by every node, so it is not in the catalog's ports.
          Drawn apart and in the failure colour, an error route stays legible on the canvas
          instead of hiding in a settings panel. */}
      {ir.kind !== 'trigger' ? (
        <span>
          <Handle
            type="source"
            id="error"
            position={Position.Bottom}
            style={{ left: '78%', background: 'var(--color-coral)' }}
            data-testid={`error-handle-${ir.id}`}
          />
          <span className="q-node__port-label q-node__port-label--error">error</span>
        </span>
      ) : null}
    </div>
  );
}
