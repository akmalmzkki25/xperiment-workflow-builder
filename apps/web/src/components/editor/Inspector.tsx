'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { IRNodeData } from '../../lib/irCanvas';
import { deriveFields } from '../../lib/schemaForm';
import { SchemaForm } from '../forms/SchemaForm';
import { useEditorContext } from './EditorContext';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

interface InspectorProps {
  ir: IRNodeData;
  allNodeIds: string[];
  onRename: (oldId: string, newId: string) => void;
  onCommitParam: (nodeId: string, name: string, value: unknown) => void;
  onConnectionRef: (nodeId: string, ref: string | undefined) => void;
  onDelete: (nodeId: string) => void;
  onDuplicate: () => void;
}

export function Inspector({
  ir,
  allNodeIds,
  onRename,
  onCommitParam,
  onConnectionRef,
  onDelete,
  onDuplicate,
}: InspectorProps) {
  const { catalogByType, connections } = useEditorContext();
  const item = catalogByType.get(ir.type);
  const fields = useMemo(() => (item ? deriveFields(item.paramsJsonSchema) : []), [item]);
  const [idDraft, setIdDraft] = useState(ir.id);

  const idError =
    idDraft === ir.id
      ? null
      : !ID_PATTERN.test(idDraft)
        ? 'Use letters, digits, _ or -, starting with a letter (max 64 chars)'
        : allNodeIds.includes(idDraft)
          ? 'Another node already uses this id'
          : null;

  const compatibleConnections = item?.requiresConnection
    ? connections.filter((c) => c.connectorKey === item.requiresConnection)
    : [];

  return (
    <aside className="q-inspector" data-testid="inspector">
      <div>
        <div className="q-inspector__section-title">Node</div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <input
              className="q-input q-input--mono"
              style={{ width: '100%' }}
              value={idDraft}
              onChange={(e) => setIdDraft(e.target.value)}
              aria-label="Node id"
              data-testid="node-id-input"
            />
            {idError ? <span className="q-field__error">{idError}</span> : null}
          </div>
          <button
            className="q-btn q-btn--ghost q-btn--sm"
            disabled={idDraft === ir.id || idError !== null}
            onClick={() => onRename(ir.id, idDraft)}
            data-testid="node-rename"
          >
            Rename
          </button>
        </div>
        <p className="q-node__sub" style={{ marginTop: 8 }}>
          {ir.type} · v{ir.operationVersion}
        </p>
      </div>

      {item?.requiresConnection ? (
        <div>
          <div className="q-inspector__section-title">Connection ({item.requiresConnection})</div>
          <select
            className="q-select"
            style={{ width: '100%', marginTop: 8 }}
            value={ir.connectionRef ?? ''}
            onChange={(e) => onConnectionRef(ir.id, e.target.value || undefined)}
            data-testid="node-connection-select"
          >
            <option value="">— select connection —</option>
            {/* A member without connection:read gets an empty list; keep the node's own
                reference selectable so a configured node never reads as unconfigured. */}
            {ir.connectionRef && !compatibleConnections.some((c) => c.id === ir.connectionRef) ? (
              <option value={ir.connectionRef}>{ir.connectionRef}</option>
            ) : null}
            {compatibleConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="q-field__hint" style={{ marginTop: 4 }}>
            <Link href="/connections">Create connection →</Link>
          </p>
        </div>
      ) : null}

      <div>
        <div className="q-inspector__section-title" style={{ marginBottom: 8 }}>
          Parameters
        </div>
        <SchemaForm
          key={ir.id}
          fields={fields}
          values={ir.parameters}
          onCommit={(name, value) => onCommitParam(ir.id, name, value)}
        />
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button
          className="q-btn q-btn--ghost q-btn--sm"
          onClick={onDuplicate}
          title="Duplicate (Ctrl+D)"
          data-testid="node-duplicate"
        >
          Duplicate
        </button>
        <button className="q-btn q-btn--danger q-btn--sm" onClick={() => onDelete(ir.id)} data-testid="node-delete">
          Delete node
        </button>
      </div>
    </aside>
  );
}
