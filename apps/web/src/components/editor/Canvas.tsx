'use client';

import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { IRNodeData } from '../../lib/irCanvas';
import { XperimentLoopNode } from './XperimentLoopNode';
import { XperimentNode } from './XperimentNode';

const nodeTypes = { xperiment: XperimentNode, xperimentLoop: XperimentLoopNode };

interface CanvasProps {
  nodes: Node<{ ir: IRNodeData }>[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onSelect: (id: string | null) => void;
}

export function Canvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onSelect }: CanvasProps) {
  return (
    <div className="q-editor__canvas" data-testid="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        deleteKeyCode={['Delete', 'Backspace']}
        connectionRadius={48}
        minZoom={0.25}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#d8d2c2" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
