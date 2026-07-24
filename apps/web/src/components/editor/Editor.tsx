'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from 'reactflow';
import { getBrowserClient, type ConnectorItem, type Finding } from '../../lib/api';
import {
  canvasToDefinition,
  definitionToCanvas,
  edgeId,
  makeNode,
  nextNodeId,
  remapEdgesForRename,
  type EditorEdge,
  type EditorNode,
  type IRNodeData,
} from '../../lib/irCanvas';
import { defaultParams } from '../../lib/schemaForm';
import { useEditorStore } from '../../stores/editorStore';
import { ActionBar } from './ActionBar';
import { Canvas } from './Canvas';
import { EditorProvider, type EditorContextValue } from './EditorContext';
import { Inspector } from './Inspector';
import { NodeLibrary } from './NodeLibrary';

type FlowNode = Node<{ ir: IRNodeData }>;

function EditorInner({ workflowId }: { workflowId: string }) {
  const { selectedNodeId, libraryOpen, select, setLibraryOpen, markDirty, reset } = useEditorStore();
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<{ ir: IRNodeData }>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const initializedRef = useRef(false);
  const previousDefinitionRef = useRef<unknown>({});

  const workflowQ = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => getBrowserClient().getWorkflow(workflowId),
  });
  const catalogQ = useQuery({ queryKey: ['connectors'], queryFn: () => getBrowserClient().listConnectors() });
  const connectionsQ = useQuery({ queryKey: ['connections'], queryFn: () => getBrowserClient().listConnections() });

  useEffect(() => {
    reset();
    return () => reset();
  }, [reset, workflowId]);

  const flow = useReactFlow();

  useEffect(() => {
    if (initializedRef.current || !workflowQ.data) return;
    const draft = workflowQ.data.draft;
    const canvas = definitionToCanvas(draft?.definition ?? {});
    setNodes(canvas.nodes as FlowNode[]);
    setEdges(canvas.edges as Edge[]);
    setRevision(draft?.revision ?? 1);
    previousDefinitionRef.current = draft?.definition ?? {};
    initializedRef.current = true;
    if (canvas.nodes.length > 0) {
      // Fit only for pre-existing graphs, after React Flow has measured them.
      // (A declarative fitView prop would fire late and shift the viewport
      // under the user's pointer on freshly-created canvases.)
      setTimeout(() => void flow.fitView({ padding: 0.3, maxZoom: 1 }), 80);
    }
  }, [workflowQ.data, setNodes, setEdges, flow]);

  const catalogByType = useMemo(
    () => new Map((catalogQ.data?.items ?? []).map((i) => [i.type, i])),
    [catalogQ.data],
  );

  const findingsByNode = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const finding of findings) {
      const key = finding.nodeId ?? '';
      map.set(key, [...(map.get(key) ?? []), finding]);
    }
    return map;
  }, [findings]);

  const contextValue: EditorContextValue = useMemo(
    () => ({ catalogByType, connections: connectionsQ.data?.items ?? [], findingsByNode }),
    [catalogByType, connectionsQ.data, findingsByNode],
  );

  const buildDefinition = useCallback((): Record<string, unknown> => {
    return canvasToDefinition({
      workflowId,
      name: workflowQ.data?.name ?? 'Workflow',
      nodes: nodes.map(
        (n): EditorNode => ({ id: n.id, type: 'xperiment', position: n.position, data: n.data }),
      ),
      edges: edges.map(
        (e): EditorEdge => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle ?? 'main',
          target: e.target,
          targetHandle: e.targetHandle ?? 'input',
        }),
      ),
      previous: previousDefinitionRef.current,
    });
  }, [workflowId, workflowQ.data, nodes, edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChangeBase(changes);
      if (changes.some((c) => c.type === 'position' || c.type === 'remove' || c.type === 'add')) markDirty();
      if (changes.some((c) => c.type === 'remove' && c.id === selectedNodeId)) select(null);
    },
    [onNodesChangeBase, markDirty, select, selectedNodeId],
  );

  const onEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChangeBase>[0]) => {
      onEdgesChangeBase(changes);
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) markDirty();
    },
    [onEdgesChangeBase, markDirty],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const sourceHandle = connection.sourceHandle ?? 'main';
      // Dedupe by endpoints, not id — ids can drift after renames.
      const duplicate = edges.some(
        (e) => e.source === connection.source && (e.sourceHandle ?? 'main') === sourceHandle && e.target === connection.target,
      );
      if (duplicate) return;
      setEdges((prev) => [
        ...prev,
        {
          id: edgeId(connection.source!, sourceHandle, connection.target!),
          source: connection.source!,
          sourceHandle,
          target: connection.target!,
          targetHandle: connection.targetHandle ?? 'input',
        },
      ]);
      markDirty();
    },
    [edges, setEdges, markDirty],
  );

  const addNodeFromItem = useCallback(
    (item: ConnectorItem) => {
      const id = nextNodeId(
        nodes.map((n) => n.id),
        item.type.replace(/\./g, '_'),
      );
      const position = { x: 120 + nodes.length * 320, y: 160 + (nodes.length % 2) * 60 };
      const node = makeNode(item, id, position, defaultParams(item.paramsJsonSchema));
      setNodes((prev) => [...prev, node as FlowNode]);
      select(id);
      markDirty();
    },
    [nodes, setNodes, select, markDirty],
  );

  const updateIr = useCallback(
    (nodeId: string, patch: (ir: IRNodeData) => IRNodeData) => {
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, data: { ir: patch(n.data.ir) } } : n)));
      markDirty();
    },
    [setNodes, markDirty],
  );

  const onCommitParam = useCallback(
    (nodeId: string, name: string, value: unknown) => {
      const current = nodes.find((n) => n.id === nodeId)?.data.ir.parameters;
      if (current) {
        const existed = name in current;
        const unchanged =
          value === undefined ? !existed : existed && JSON.stringify(current[name]) === JSON.stringify(value);
        if (unchanged) return; // blurring an untouched field must not dirty the draft
      }
      updateIr(nodeId, (ir) => {
        const parameters = { ...ir.parameters };
        if (value === undefined) delete parameters[name];
        else parameters[name] = value;
        return { ...ir, parameters };
      });
    },
    [nodes, updateIr],
  );

  const onConnectionRef = useCallback(
    (nodeId: string, ref: string | undefined) => {
      updateIr(nodeId, (ir) => {
        const next = { ...ir };
        if (ref) next.connectionRef = ref;
        else delete next.connectionRef;
        return next;
      });
    },
    [updateIr],
  );

  const onRename = useCallback(
    (oldId: string, newId: string) => {
      setNodes((prev) =>
        prev.map((n) => (n.id === oldId ? { ...n, id: newId, data: { ir: { ...n.data.ir, id: newId } } } : n)),
      );
      // Endpoints AND ids must follow the rename — stale ids break edge dedupe.
      setEdges((prev) => remapEdgesForRename(prev, oldId, newId));
      select(newId);
      markDirty();
    },
    [setNodes, setEdges, select, markDirty],
  );

  const onDelete = useCallback(
    (nodeId: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
      select(null);
      markDirty();
    },
    [setNodes, setEdges, select, markDirty],
  );

  if (workflowQ.isLoading || catalogQ.isLoading) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading editor…</p>;
  }
  if (workflowQ.isError || !workflowQ.data) {
    return <div className="q-banner">Could not load this workflow.</div>;
  }
  if (catalogQ.isError) {
    // Without the catalog, readiness badges and forms would silently lie.
    return <div className="q-banner">Could not load the connector catalog — check the API and reload.</div>;
  }

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  return (
    <EditorProvider value={contextValue}>
      <div className="q-editor-page">
        <ActionBar
          workflow={workflowQ.data}
          revision={revision}
          setRevision={setRevision}
          buildDefinition={buildDefinition}
          onDefinitionSaved={(definition) => {
            previousDefinitionRef.current = definition;
          }}
          findings={findings}
          setFindings={setFindings}
          nodeCount={nodes.length}
          onToggleLibrary={() => setLibraryOpen(!libraryOpen)}
        />
        <div className="q-editor">
          {libraryOpen ? <NodeLibrary items={catalogQ.data?.items ?? []} onAdd={addNodeFromItem} /> : null}
          <Canvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelect={select}
          />
          {selectedNode ? (
            <Inspector
              key={selectedNode.id}
              ir={selectedNode.data.ir}
              allNodeIds={nodes.map((n) => n.id)}
              onRename={onRename}
              onCommitParam={onCommitParam}
              onConnectionRef={onConnectionRef}
              onDelete={onDelete}
            />
          ) : null}
        </div>
      </div>
    </EditorProvider>
  );
}

export function Editor({ workflowId }: { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner workflowId={workflowId} />
    </ReactFlowProvider>
  );
}
