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
  canRedo,
  canUndo,
  emptyHistory,
  nodeChangeVerdict,
  pushSnapshot,
  redo,
  undo,
  type History,
} from '../../lib/history';
import {
  canvasToDefinition,
  definitionToCanvas,
  edgeId,
  makeNode,
  nextNodeId,
  remapEdgesForRename,
  toEditorNode,
  type EditorEdge,
  type IRNodeData,
} from '../../lib/irCanvas';
import { runStatusByNode } from '../../lib/runStatus';
import { defaultParams } from '../../lib/schemaForm';
import { useEditorStore } from '../../stores/editorStore';
import { ActionBar } from './ActionBar';
import { useEditorHotkeys } from './useEditorHotkeys';
import { RunBanner } from './RunBanner';
import { AiDock } from './AiDock';
import { Canvas } from './Canvas';
import { EditorProvider, type EditorContextValue } from './EditorContext';
import { Inspector } from './Inspector';
import { NodeLibrary } from './NodeLibrary';

type FlowNode = Node<{ ir: IRNodeData }>;
/**
 * One point on the undo trail.
 *
 * The arrays are stored by reference, not cloned: React Flow replaces them immutably
 * on every change, so yesterday's array is still yesterday's canvas.
 */
interface CanvasSnapshot {
  nodes: FlowNode[];
  edges: Edge[];
}

const TERMINAL_RUN_STATUS = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED']);
/** An approval or a long timer never terminates; stop watching rather than poll forever. */
const WATCH_DEADLINE_MS = 10 * 60 * 1000;

function EditorInner({ workflowId }: { workflowId: string }) {
  const { selectedNodeId, libraryOpen, select, setLibraryOpen, markDirty, reset } = useEditorStore();
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<{ ir: IRNodeData }>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [runExecutionId, setRunExecutionId] = useState<string | null>(null);
  const [watchStartedAt, setWatchStartedAt] = useState<number | null>(null);
  const [history, setHistory] = useState<History<CanvasSnapshot>>(emptyHistory<CanvasSnapshot>);
  const [saveSignal, setSaveSignal] = useState(0);
  const initializedRef = useRef(false);
  const previousDefinitionRef = useRef<unknown>({});
  /** True between a drag's first moved frame and its last, so one gesture is one entry. */
  const draggingRef = useRef(false);

  // Last COMMITTED canvas. Effects run after commit, so inside an event handler these
  // hold the state as it was before the edit being handled — exactly what to snapshot.
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const historyRef = useRef(history);
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    historyRef.current = history;
  });

  const recordEdit = useCallback(() => {
    setHistory((h) => pushSnapshot(h, { nodes: nodesRef.current, edges: edgesRef.current }));
  }, []);

  const workflowQ = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => getBrowserClient().getWorkflow(workflowId),
  });
  const catalogQ = useQuery({ queryKey: ['connectors'], queryFn: () => getBrowserClient().listConnectors() });
  const connectionsQ = useQuery({ queryKey: ['connections'], queryFn: () => getBrowserClient().listConnections() });

  useEffect(() => {
    reset();
    // The undo trail is per workflow. Without this it would survive a switch and let
    // Ctrl+Z paste the previous workflow's canvas over this one. `initializedRef` is
    // cleared for the same reason — otherwise the new workflow's draft never loads.
    setHistory(emptyHistory<CanvasSnapshot>());
    draggingRef.current = false;
    initializedRef.current = false;
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

  // The SAME query key the execution detail page owns. TanStack dedupes by key, so there
  // is exactly one poller and one cache entry — one truth — and navigating from here to
  // /executions/{id} lands on a warm cache rather than refetching.
  const runQ = useQuery({
    queryKey: ['execution', runExecutionId],
    queryFn: () => getBrowserClient().getExecution(runExecutionId!),
    enabled: runExecutionId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.execution.status;
      if (status && TERMINAL_RUN_STATUS.has(status)) return false;
      // A run parked on an approval or a timer never reaches a terminal status, so an
      // uncapped interval would poll for days from an open tab.
      if (watchStartedAt !== null && Date.now() - watchStartedAt > WATCH_DEADLINE_MS) return false;
      return 2000;
    },
  });

  const runStatuses = useMemo(() => runStatusByNode(runQ.data?.nodes ?? []), [runQ.data]);

  const contextValue: EditorContextValue = useMemo(
    () => ({
      catalogByType,
      connections: connectionsQ.data?.items ?? [],
      findingsByNode,
      runStatusByNode: runStatuses,
    }),
    [catalogByType, connectionsQ.data, findingsByNode, runStatuses],
  );

  const buildDefinition = useCallback((): Record<string, unknown> => {
    return canvasToDefinition({
      workflowId,
      name: workflowQ.data?.name ?? 'Workflow',
      nodes: nodes.map(toEditorNode),
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
      const verdict = nodeChangeVerdict(changes, draggingRef.current);
      // Snapshot BEFORE applying, so undo restores the canvas as it stood.
      if (verdict.push) recordEdit();
      draggingRef.current = verdict.gesture;
      onNodesChangeBase(changes);
      if (changes.some((c) => c.type === 'position' || c.type === 'remove' || c.type === 'add')) markDirty();
      if (changes.some((c) => c.type === 'remove' && c.id === selectedNodeId)) select(null);
    },
    [onNodesChangeBase, markDirty, select, selectedNodeId, recordEdit],
  );

  const onEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChangeBase>[0]) => {
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) recordEdit();
      onEdgesChangeBase(changes);
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) markDirty();
    },
    [onEdgesChangeBase, markDirty, recordEdit],
  );

  const applyStep = useCallback(
    (step: { history: History<CanvasSnapshot>; restored: CanvasSnapshot } | null) => {
      if (!step) return;
      setHistory(step.history);
      setNodes(step.restored.nodes);
      setEdges(step.restored.edges);
      // A selection pointing at a node this step removed would leave the Inspector
      // rendering a node that is no longer on the canvas.
      const current = useEditorStore.getState().selectedNodeId;
      if (current && !step.restored.nodes.some((n) => n.id === current)) select(null);
      markDirty();
    },
    [setNodes, setEdges, select, markDirty],
  );

  const onUndo = useCallback(() => {
    applyStep(undo(historyRef.current, { nodes: nodesRef.current, edges: edgesRef.current }));
  }, [applyStep]);

  const onRedo = useCallback(() => {
    applyStep(redo(historyRef.current, { nodes: nodesRef.current, edges: edgesRef.current }));
  }, [applyStep]);

  useEditorHotkeys(
    useCallback(
      (action) => {
        if (action === 'undo') onUndo();
        else if (action === 'redo') onRedo();
        else if (action === 'save') setSaveSignal((n) => n + 1);
        // The palette has no search field until B6; opening it is the useful half now.
        else if (action === 'search') setLibraryOpen(true);
      },
      [onUndo, onRedo, setLibraryOpen],
    ),
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
      recordEdit();
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
    [edges, setEdges, markDirty, recordEdit],
  );

  const addNodeFromItem = useCallback(
    (item: ConnectorItem) => {
      const id = nextNodeId(
        nodes.map((n) => n.id),
        item.type.replace(/\./g, '_'),
      );
      const position = { x: 120 + nodes.length * 320, y: 160 + (nodes.length % 2) * 60 };
      const node = makeNode(item, id, position, defaultParams(item.paramsJsonSchema));
      recordEdit();
      setNodes((prev) => [...prev, node as FlowNode]);
      select(id);
      markDirty();
    },
    [nodes, setNodes, select, markDirty, recordEdit],
  );

  const updateIr = useCallback(
    (nodeId: string, patch: (ir: IRNodeData) => IRNodeData) => {
      recordEdit();
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, data: { ir: patch(n.data.ir) } } : n)));
      markDirty();
    },
    [setNodes, markDirty, recordEdit],
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
      recordEdit();
      setNodes((prev) =>
        prev.map((n) => (n.id === oldId ? { ...n, id: newId, data: { ir: { ...n.data.ir, id: newId } } } : n)),
      );
      // Endpoints AND ids must follow the rename — stale ids break edge dedupe.
      setEdges((prev) => remapEdgesForRename(prev, oldId, newId));
      select(newId);
      markDirty();
    },
    [setNodes, setEdges, select, markDirty, recordEdit],
  );

  const onDelete = useCallback(
    (nodeId: string) => {
      recordEdit();
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
      select(null);
      markDirty();
    },
    [setNodes, setEdges, select, markDirty, recordEdit],
  );

  const applyDefinition = useCallback(
    (ir: unknown) => {
      // Applying an AI draft replaces the whole graph — the one edit most worth undoing.
      recordEdit();
      const canvas = definitionToCanvas(ir);
      // Preserve the user's arrangement for any node the AI kept — the model's
      // IR usually omits metadata.layout, which would otherwise flatten the graph.
      setNodes((prev) => {
        const priorPositions = new Map(prev.map((n) => [n.id, n.position]));
        return canvas.nodes.map((n) => {
          const prior = priorPositions.get(n.id);
          return (prior ? { ...n, position: prior } : n) as FlowNode;
        });
      });
      setEdges(canvas.edges as Edge[]);
      select(null);
      markDirty();
      setAiOpen(false);
      if (canvas.nodes.length > 0) setTimeout(() => void flow.fitView({ padding: 0.3, maxZoom: 1 }), 80);
    },
    [setNodes, setEdges, select, markDirty, flow, recordEdit],
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
          saveSignal={saveSignal}
          canUndo={canUndo(history)}
          canRedo={canRedo(history)}
          onUndo={onUndo}
          onRedo={onRedo}
          onToggleLibrary={() => setLibraryOpen(!libraryOpen)}
          onToggleAi={() => setAiOpen((v) => !v)}
          onRunStarted={(executionId) => {
            setRunExecutionId(executionId);
            setWatchStartedAt(Date.now());
          }}
        />
        {runExecutionId ? (
          <RunBanner
            executionId={runExecutionId}
            detail={runQ.data}
            watchExpired={watchStartedAt !== null && Date.now() - watchStartedAt > WATCH_DEADLINE_MS}
            onStopWatching={() => {
              setRunExecutionId(null);
              setWatchStartedAt(null);
            }}
          />
        ) : null}
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
          <AiDock
            open={aiOpen}
            onClose={() => setAiOpen(false)}
            hasNodes={nodes.length > 0}
            currentDefinition={buildDefinition}
            onApply={applyDefinition}
          />
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
