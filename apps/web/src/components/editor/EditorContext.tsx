'use client';

import { createContext, useContext } from 'react';
import type { ConnectionRow, ConnectorItem, Finding } from '../../lib/api';

export interface EditorContextValue {
  catalogByType: Map<string, ConnectorItem>;
  connections: ConnectionRow[];
  /** Validation findings grouped by nodeId ('' key = workflow-level). */
  findingsByNode: Map<string, Finding[]>;
  /**
   * Live status per AUTHORED node id while a run is being watched.
   *
   * Context only, never `node.data.ir`: canvasToDefinition spreads `ir` straight into the
   * saved definition, so a status field there would be persisted into the workflow IR and
   * then rejected by validation on the next Save.
   */
  runStatusByNode: Map<string, string>;
}

const Ctx = createContext<EditorContextValue | null>(null);

export const EditorProvider = Ctx.Provider;

export function useEditorContext(): EditorContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useEditorContext must be used inside EditorProvider');
  return value;
}
