import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, ControlButton, MiniMap, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, useReactFlow, useConnection, useNodesInitialized, useStore,
  type Viewport, type OnConnectEnd, type Connection, type Edge as FlowEdge, type EdgeChange, type IsValidConnection, type NodeChange, type OnSelectionChangeParams
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './graphEditor.css';
import { Download, LayoutGrid, Plus, Focus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { zipSync, strToU8 } from 'fflate';
import { MaterialGraph, type MaterialGraphConnection, type MaterialGraphDiagnostic, type MaterialGraphInput, type MaterialGraphNode, type MaterialGraphType } from '@meimu/mutracer';
import { showToast, useViewer, type SelectedMaterial } from '../../store';
import { getEngine } from '../../engine/ViewerEngine';
import {
  TERMINALS, addConnectedNode, copyNodes, pasteNodes, sameNode, canonicalTerminal, categoryTypes, connect, connectionError, disconnect, layoutGraph, nodeOutputs, nodePorts,
  reachable, reconnect, removeNodes, removeUnused, setNodeType, setParameter, type NodeChoice, type AddAnchor, type Target
} from '../../engine/graphEdit';
import { NodePalette, type PaletteRequest } from './NodePalette';
import { exportMaterialX } from '../../engine/materialxExport';
import { graphImageFile, graphImageName } from '../../engine/materialxGraphArchive';
import { normalizeGraph } from '../../../../src/renderer/materialGraph/normalize';
import { outputType } from '../../../../src/renderer/materialGraph/nodes';
import { Select } from '../ui/controls';
import { ParamEditor } from './ParamEditor';
import { useGraphDiagnostics } from '../panels/MaterialPanel';
import { GraphEditing, NODE_TYPES, SURFACE, shortId, type MxFlowNode, type PortView, type SurfaceFlowNode } from './GraphNodes';

type FlowNode = MxFlowNode | SurfaceFlowNode;
const EMPTY = new MaterialGraph();
/** Fitting never zooms out so far that node labels become unreadable; the rest is a pan away. */
const FIT_VIEW = { padding: 0.15, minZoom: 0.85, maxZoom: 1 };
// View state survives material selection and dock remounts without entering material undo/export.
interface GraphView { positions: Map<string, { x: number; y: number }>; viewport?: Viewport }
const views = new Map<string, GraphView>();
let clipboard: { nodes: readonly MaterialGraphNode[]; positions: Map<string, { x: number; y: number }> } | undefined;
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Keep one nearby driver visible beside the surface instead of centering it at the canvas edge. */
function surfaceNeighborhood(nodes: FlowNode[], graph: MaterialGraph) {
  const surface = nodes.find(n => n.id === SURFACE);
  if (!surface) return [];
  const drivers = new Set(Object.values(graph.terminal).flatMap(edge => edge ? [edge.node] : []));
  const distance = (n: FlowNode) => Math.hypot(n.position.x - surface.position.x, n.position.y - surface.position.y);
  const nearby = nodes.filter(n => drivers.has(n.id) && distance(n) < 700).sort((a, b) => distance(a) - distance(b));
  return [surface, ...nearby.slice(0, 1)];
}

const targetOf = (node: string, handle: string | null | undefined): Target =>
  node === SURFACE ? { terminal: handle ?? '' } : { node, port: handle ?? '' };
const sourceOf = (node: string, handle: string | null | undefined): MaterialGraphConnection =>
  handle && handle !== 'out' ? { node, output: handle } : { node };

/** Workspace panel that edits the selected material's MaterialX graph. */
export default function GraphEditor() {
  const material = useViewer(s => s.material);
  return (
    <section className="panel graph-editor" aria-label="Material node graph">
      {material
        ? <ReactFlowProvider key={material.id}><Workspace material={material} /></ReactFlowProvider>
        : <div className="graph-editor__empty">Select a material to edit its node graph.</div>}
    </section>
  );
}

function Workspace({ material }: { material: SelectedMaterial }) {
  const flow = useReactFlow<FlowNode>();
  // The store's material changes whenever its graph is replaced, including undo.
  const graph = useMemo(() => getEngine()?.materialGraph(material.id) ?? EMPTY, [material]);
  const engineState = useGraphDiagnostics();
  const view = useMemo(() => {
    let cached = views.get(material.id);
    if (!cached) {
      cached = { positions: new Map() };
      if (views.size >= 64) views.delete(views.keys().next().value!);
      views.set(material.id, cached);
    }
    return cached;
  }, [material.id]);
  const positions = useRef(view.positions);
  const initialized = useNodesInitialized();
  const navigated = useRef(!!view.viewport);
  useEffect(() => {
    if (initialized && !navigated.current) {
      navigated.current = true;
      void flow.fitView({ ...FIT_VIEW, nodes: surfaceNeighborhood(flow.getNodes(), graph) });
    }
  }, [initialized, flow, graph]);
  const canvas = useRef<HTMLDivElement>(null);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const [palette, setPalette] = useState<PaletteRequest | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const reconnecting = useRef(false);
  const lastRejection = useRef<string | null>(null);
  const [layoutRun, setLayoutRun] = useState(0);
  const currentGraph = useRef(graph);
  currentGraph.current = graph;
  const editing = useMemo(() => ({ materialId: material.id, set: (id: string, port: string, value: MaterialGraphInput['value']) => {
    const latest = getEngine()?.materialGraph(material.id) ?? currentGraph.current;
    getEngine()?.setMaterialGraph(material.id, setParameter(latest, id, port, value), `${shortId(id)} ${port}`, `${material.id}:${id}.${port}`);
  } }), [material.id]);

  const commit = useCallback((next: MaterialGraph, label: string, mergeKey?: string) => {
    getEngine()?.setMaterialGraph(material.id, next, label, mergeKey);
  }, [material.id]);

  const ids = useMemo(() => new Set(graph.nodes.map(n => n.id)), [graph]);
  const live = useMemo(() => reachable(graph), [graph]);
  const diagnostics = useMemo(() => {
    const local = normalizeGraph(graph).diagnostics;
    const engine = (engineState?.diagnostics ?? []).filter(d => d.node ? ids.has(d.node) : true);
    const seen = new Set<string>();
    return [...local, ...engine].filter(d => {
      const key = `${d.code}|${d.node}|${d.port}|${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [graph, ids, engineState]);

  const pendingSelection = useRef(new Set<string>());

  // Rebuild the view from the graph, keeping positions, sizes and selection.
  useEffect(() => {
    const errors = new Map<string, string[]>();
    for (const d of diagnostics) if (d.node) errors.set(d.node, [...(errors.get(d.node) ?? []), d.port ? `${d.port}: ${d.message}` : d.message]);
    let layout: ReturnType<typeof layoutGraph> | undefined;
    const place = (id: string) => {
      let position = positions.current.get(id);
      if (!position) {
        layout ??= layoutGraph(graph);
        position = id === SURFACE ? layout.surface : layout.positions.get(id) ?? { x: 0, y: 0 };
        positions.current.set(id, position);
      }
      return position;
    };
    const picked = pendingSelection.current;
    pendingSelection.current = new Set();
    setNodes(prev => {
      const old = new Map(prev.map(n => [n.id, n]));
      const connectedTerminals = new Set(Object.entries(graph.terminal).filter(([, e]) => e).map(([name]) => canonicalTerminal(name)));
      const oldSurface = old.get(SURFACE) as SurfaceFlowNode | undefined;
      const terminals = TERMINALS.map(([name, type]) => ({ name, type, connected: connectedTerminals.has(name) }));
      const surface: SurfaceFlowNode = {
        ...(old.get(SURFACE) as SurfaceFlowNode | undefined), id: SURFACE, type: 'surface', position: place(SURFACE), deletable: false,
        data: oldSurface && oldSurface.data.terminals.every((t, i) => t.connected === terminals[i].connected) ? oldSurface.data : { terminals }
      };
      const items: FlowNode[] = graph.nodes.map(node => {
        const previous = old.get(node.id) as MxFlowNode | undefined;
        const nodeErrors = errors.get(node.id) ?? [];
        if (previous && sameNode(previous.data.node, node) && previous.data.unused === !live.has(node.id) && sameList(previous.data.errors, nodeErrors))
          return previous.position === place(node.id) ? previous : { ...previous, position: place(node.id) };
        const ports = nodePorts(node);
        const view: PortView[] = Object.entries(ports).map(([name, def]) => {
          const authored = node.inputs?.[name];
          return { name, type: authored?.type ?? def.type, input: authored ?? def, connected: !!authored?.connection };
        });
        return {
          ...(old.get(node.id) as MxFlowNode | undefined), id: node.id, type: 'mx', position: place(node.id), selected: picked.has(node.id) || old.get(node.id)?.selected || false,
          data: { node, ports: view, outputs: nodeOutputs(node).map(name => ({ name, type: outputType(node, name)! })), errors: errors.get(node.id) ?? [], unused: !live.has(node.id) }
        };
      });
      return [...items, surface];
    });
    setEdges(prev => {
      const old = new Map(prev.map(e => [e.id, e]));
      const list: FlowEdge[] = [];
      const add = (id: string, source: MaterialGraphConnection, target: string, handle: string, type: MaterialGraphType | undefined) => {
        if (!ids.has(source.node)) return;
        const previous = old.get(id), sourceHandle = source.output ?? 'out', className = `gx-edge gx-edge--${type ?? 'float'}`;
        list.push(previous && previous.source === source.node && previous.sourceHandle === sourceHandle && previous.target === target && previous.targetHandle === handle && previous.className === className
          ? previous : { ...previous, id, source: source.node, sourceHandle, target, targetHandle: handle, className });
      };
      for (const node of graph.nodes) for (const [port, input] of Object.entries(node.inputs ?? {}))
        if (input.connection) add(`${node.id}\u0000${port}`, input.connection, node.id, port, input.type);
      for (const [name, edge] of Object.entries(graph.terminal)) if (edge) {
        const canonical = canonicalTerminal(name);
        add(`${SURFACE}\u0000${canonical}`, edge, SURFACE, canonical, TERMINALS.find(([t]) => t === canonical)?.[1]);
      }
      return sameList(prev, list) ? prev : list;
    });
  }, [graph, diagnostics, ids, live, layoutRun]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    for (const change of changes) if (change.type === 'position' && change.position) positions.current.set(change.id, change.position);
    setNodes(n => applyNodeChanges(changes.filter(c => c.type !== 'remove'), n));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges(e => applyEdgeChanges(changes.filter(c => c.type !== 'remove'), e)), []);

  const isValidConnection = useCallback<IsValidConnection>((c) => {
    if (c.source === SURFACE) return false;
    const error = connectionError(graph, sourceOf(c.source, c.sourceHandle), targetOf(c.target, c.targetHandle));
    lastRejection.current = error;
    return !error;
  }, [graph]);

  const onConnect = useCallback((c: Connection) => {
    try {
      commit(connect(graph, sourceOf(c.source, c.sourceHandle), targetOf(c.target, c.targetHandle)), `Connect ${shortId(c.source)} → ${c.target === SURFACE ? c.targetHandle : shortId(c.target)}`);
      setRejected(null);
    } catch (error) { setRejected((error as Error).message); }
  }, [graph, commit]);

  // Failed/empty rewire drops cancel; users explicitly delete a wire to disconnect it.
  const onReconnect = useCallback((edge: FlowEdge, c: Connection) => {
    try {
      commit(reconnect(graph, sourceOf(c.source, c.sourceHandle), targetOf(edge.target, edge.targetHandle), targetOf(c.target, c.targetHandle)), 'Rewire connection');
      setRejected(null);
    } catch (error) { setRejected((error as Error).message); }
  }, [graph, commit]);

  const onDelete = useCallback(({ nodes: gone, edges: cut }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    const removed = new Set(gone.map(n => n.id).filter(id => id !== SURFACE));
    let next = removed.size ? removeNodes(graph, removed) : graph;
    for (const edge of cut) if (!removed.has(edge.source) && !removed.has(edge.target)) next = disconnect(next, targetOf(edge.target, edge.targetHandle));
    if (next !== graph) commit(next, removed.size ? `Delete ${removed.size === 1 ? shortId([...removed][0]) : `${removed.size} nodes`}` : 'Disconnect');
  }, [graph, commit]);

  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    setSelected(picked.length === 1 && picked[0].id !== SURFACE ? picked[0].id : null);
  }, []);

  const closePalette = useCallback(() => { setPalette(null); canvas.current?.focus(); }, []);
  const openPalette = (point?: { x: number; y: number } | null, anchor?: AddAnchor) => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    const p = point ?? { x: box.left + box.width / 2, y: box.top + box.height / 3 };
    setPalette({ x: Math.max(8, Math.min(p.x - box.left, box.width - 320)),
      y: Math.max(8, Math.min(p.y - box.top, box.height - 300)), position: flow.screenToFlowPosition(p), anchor });
  };
  const add = (choice: NodeChoice) => {
    if (!palette) return;
    try {
      const { graph: next, id } = addConnectedNode(graph, choice, palette.anchor);
      positions.current.set(id, palette.position);
      commit(next, palette.anchor ? `Add and connect ${choice.category}` : `Add ${choice.category}`);
      setNodes(n => n.map(node => ({ ...node, selected: false })));
      pendingSelection.current = new Set([id]);
      setSelected(id);
      closePalette();
    } catch (error) { setRejected((error as Error).message); }
  };
  const onConnectEnd: OnConnectEnd = (event, state) => {
    if (!reconnecting.current && !state.isValid && !state.toHandle && state.fromNode && state.fromHandle &&
      event.target instanceof Element && event.target.classList.contains('react-flow__pane')) {
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      const anchor: AddAnchor = state.fromHandle.type === 'source'
        ? { source: sourceOf(state.fromNode.id, state.fromHandle.id) }
        : { target: targetOf(state.fromNode.id, state.fromHandle.id) };
      openPalette({ x: point.clientX, y: point.clientY }, anchor);
    } else if (lastRejection.current) setRejected(lastRejection.current);
    lastRejection.current = null;
  };
  const focusSelection = () => {
    const picked = flow.getNodes().filter(n => n.selected);
    void flow.fitView({ ...FIT_VIEW, nodes: picked.length ? picked : surfaceNeighborhood(flow.getNodes(), graph), duration: 200 });
  };
  const relayout = () => {
    const layout = layoutGraph(graph);
    for (const [id, p] of layout.positions) positions.current.set(id, p);
    positions.current.set(SURFACE, layout.surface);
    setLayoutRun(run => run + 1);
    // Keep the viewport still; arranging is distinct from navigating.
  };
  const copy = () => {
    const picked = flow.getNodes().filter(n => n.selected && n.id !== SURFACE);
    if (!picked.length) return false;
    clipboard = { nodes: copyNodes(graph, picked.map(n => n.id)), positions: new Map(picked.map(n => [n.id, n.position])) };
    return true;
  };
  const paste = (duplicate = false) => {
    if (!clipboard?.nodes.length) return;
    const { graph: next, mapping } = pasteNodes(graph, clipboard.nodes);
    const sourcePositions = [...clipboard.positions.values()];
    const min = { x: Math.min(...sourcePositions.map(p => p.x)), y: Math.min(...sourcePositions.map(p => p.y)) };
    const box = canvas.current!.getBoundingClientRect();
    const at = duplicate ? { x: min.x + 40, y: min.y + 40 } : flow.screenToFlowPosition(cursor.current ?? { x: box.left + box.width / 2, y: box.top + box.height / 3 });
    for (const [old, id] of mapping) {
      const p = clipboard.positions.get(old) ?? min;
      positions.current.set(id, { x: p.x - min.x + at.x, y: p.y - min.y + at.y });
    }
    commit(next, duplicate ? 'Duplicate nodes' : 'Paste nodes');
    setNodes(n => n.map(node => ({ ...node, selected: false })));
    pendingSelection.current = new Set(mapping.values());
    setSelected(mapping.size === 1 ? [...mapping.values()][0] : null);
  };

  const unused = graph.nodes.length - live.size;
  const selectedNode = selected ? graph.nodes.find(n => n.id === selected) : undefined;
  const status = engineState?.status;
  const general = diagnostics.filter(d => !d.node || !ids.has(d.node));
  const nodeErrors = diagnostics.length - general.length;

  return (
    <>
      <header className="graph-editor__bar">
        <strong title={material.name}>{material.name}</strong>
        <button className="btn sm" title="Add node (Space / Tab)" onClick={() => openPalette()}><Plus size={13} />Node</button>
        <button className="btn sm" title="Show parameter inspector" aria-pressed={inspecting} onClick={() => setInspecting(!inspecting)}><SlidersHorizontal size={13} /></button>
        <button className="btn sm" title="Arrange nodes by depth" onClick={relayout}><LayoutGrid size={13} />Layout</button>
        <button className="btn sm" disabled={!unused} title="Remove nodes no surface input reaches" onClick={() => commit(removeUnused(graph), 'Remove unused nodes')}>
          <Trash2 size={13} />Unused{unused ? ` (${unused})` : ''}
        </button>
        <button className="btn sm" disabled={!graph.nodes.length} title="Export the graph and material values as MaterialX" onClick={() => void exportGraph(graph, material)}>
          <Download size={13} />.mtlx
        </button>
        <span className="graph-editor__status" role="status" data-state={status} title={[...general, ...diagnostics.filter(d => d.node && ids.has(d.node))].map(describe).join('\n')}>
          {rejected ?? (general.length ? general.map(d => d.message).filter((m, i, a) => a.indexOf(m) === i).join(' · ')
            : nodeErrors ? `${nodeErrors} node ${nodeErrors === 1 ? 'error' : 'errors'}`
              : status === 'compiling' ? 'Compiling…' : '')}
        </span>
      </header>
      <div className="graph-editor__body">
        <div ref={canvas} className="graph-editor__canvas" tabIndex={0} aria-label="Node graph canvas"
          onPointerMove={e => { cursor.current = { x: e.clientX, y: e.clientY }; }}
          onPointerDown={e => { if (e.target instanceof Element && !e.target.closest('input, button, select, .nodrag')) canvas.current?.focus(); }}
          onKeyDown={e => {
            if ((e.target as Element).closest('input, textarea, select, button, [role="dialog"], [contenteditable="true"]')) return;
            if (e.code === 'Space' || e.key === 'Tab') {
              if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
              e.preventDefault(); e.stopPropagation(); openPalette(cursor.current);
            } else if ((e.metaKey || e.ctrlKey) && !e.altKey) {
              if (e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); }
              if (e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); }
              if (e.key.toLowerCase() === 'd') { e.preventDefault(); if (copy()) paste(true); }
            } else if (e.key.toLowerCase() === 'f') { e.preventDefault(); focusSelection(); }
          }}>
          <GraphEditing.Provider value={editing}>
          <ReactFlow<FlowNode>
            nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} colorMode="dark"
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={isValidConnection}
            onConnectStart={() => { lastRejection.current = null; setRejected(null); }} onConnectEnd={onConnectEnd}
            onReconnect={onReconnect} onReconnectStart={() => { reconnecting.current = true; lastRejection.current = null; setRejected(null); }}
            onReconnectEnd={() => { reconnecting.current = false; if (lastRejection.current) setRejected(lastRejection.current); lastRejection.current = null; }}
            onDelete={onDelete} onSelectionChange={onSelectionChange}
            deleteKeyCode={['Backspace', 'Delete']} defaultViewport={view.viewport}
            onMoveEnd={(_, viewport) => { view.viewport = viewport; }}
            onNodeDoubleClick={(_, node) => void flow.fitView({ nodes: [node], minZoom: 0.9, maxZoom: 1, duration: 200 })}
            connectionRadius={16} minZoom={0.3} maxZoom={2} panActivationKeyCode={null}
            panOnScroll zoomActivationKeyCode={['Meta', 'Control']} panOnDrag={[0, 1]}
            proOptions={{ hideAttribution: true }}>
            <Background gap={20} size={1} />
            <Controls showInteractive={false} showFitView={false}>
              <ControlButton className="react-flow__controls-fitview" title="Focus selection or surface (F)" aria-label="Focus selection or surface" onClick={focusSelection}><Focus size={15} /></ControlButton>
            </Controls>
            <MiniMap pannable zoomable nodeColor="var(--cv-text-4)" nodeStrokeColor="var(--cv-control-border)"
              maskColor="color-mix(in srgb, var(--cv-workspace) 80%, transparent)" />
            <WireHint graph={graph} />
          </ReactFlow>
          </GraphEditing.Provider>
          {palette && <NodePalette request={palette} graph={graph} onAdd={add} onClose={closePalette} />}
          <span className="gx-shortcuts">Space add · F focus · ⌘/Ctrl D duplicate</span>
        </div>
        {inspecting && selectedNode && <Inspector key={selectedNode.id} node={selectedNode} graph={graph} material={material} commit={commit} />}
      </div>
    </>
  );
}

const describe = (d: MaterialGraphDiagnostic) => `${d.node ? shortId(d.node) : ''}${d.port ? `.${d.port}` : ''}${d.node || d.port ? ': ' : ''}${d.message}`;

function WireHint({ graph }: { graph: MaterialGraph }) {
  const wire = useConnection();
  const width = useStore(s => s.width), height = useStore(s => s.height);
  if (!wire.inProgress || !wire.toHandle || !wire.toNode || !wire.fromNode || !wire.fromHandle) return null;
  const source = wire.fromHandle.type === 'source' ? sourceOf(wire.fromNode.id, wire.fromHandle.id) : sourceOf(wire.toNode.id, wire.toHandle.id);
  const target = wire.fromHandle.type === 'source' ? targetOf(wire.toNode.id, wire.toHandle.id) : targetOf(wire.fromNode.id, wire.fromHandle.id);
  const error = connectionError(graph, source, target);
  return error ? <div className="gx-wire-hint" role="status" style={{
    left: Math.max(8, Math.min((wire.pointer?.x ?? 0) + 16, width - 280)),
    top: Math.max(8, Math.min((wire.pointer?.y ?? 0) - 42, height - 52))
  }}>{error}</div> : null;
}

/** Parameters of the selected node. */
function Inspector({ node, graph, material, commit }: {
  node: MaterialGraphNode; graph: MaterialGraph; material: SelectedMaterial;
  commit: (next: MaterialGraph, label: string, mergeKey?: string) => void;
}) {
  const types = categoryTypes(node.category);
  const set = (port: string, value: MaterialGraphInput['value'] | undefined) =>
    commit(setParameter(graph, node.id, port, value), `${shortId(node.id)} ${port}`, `${material.id}:${node.id}.${port}`);
  return (
    <aside className="gx-inspector" aria-label={`${node.category} parameters`}>
      <header>
        <b>{node.category}</b>
        <small title={node.id}>{shortId(node.id)}</small>
      </header>
      {types.length > 1 && <Select label="Output type" prefix="Type" value={node.type}
        options={types.map(t => ({ value: t, label: t }))}
        onChange={type => commit(setNodeType(graph, node.id, type), `${shortId(node.id)} type`)} />}
      {Object.entries(nodePorts(node)).map(([port, def]) => {
        const authored = node.inputs?.[port];
        const input = authored ?? def;
        return (
          <div key={port} className="gx-param" data-authored={authored && !authored.connection ? true : undefined}>
            <span className="gx-param__name" title={`${port} (${input.type})`}>{port}</span>
            {authored?.connection
              ? <span className="gx-param__link">
                ← {shortId(authored.connection.node)}{authored.connection.output ? `.${authored.connection.output}` : ''}
                <button className="graph-use" onClick={() => commit(disconnect(graph, { node: node.id, port }), `Disconnect ${port}`)}>Disconnect</button>
              </span>
              : <ParamEditor port={port} input={input} node={node} materialId={material.id} onChange={value => set(port, value)} />}
            {authored && !authored.connection && <button className="gx-param__reset" title="Restore the default" aria-label={`Reset ${port}`} onClick={() => set(port, undefined)}>↺</button>}
          </div>
        );
      })}
    </aside>
  );
}

/** Downloads the graph as `.mtlx`, or as a `.zip` with its images. */
async function exportGraph(graph: MaterialGraph, material: SelectedMaterial) {
  const { text, images } = exportMaterialX(graph, material.values, material.name, graphImageName);
  const base = (material.name || 'material').replace(/[\\/:*?"<>|]+/g, '_');
  if (!images.length) return save(new Blob([text], { type: 'application/xml' }), `${base}.mtlx`);
  const files: Record<string, Uint8Array> = { [`${base}.mtlx`]: strToU8(text) };
  const missing: string[] = [];
  await Promise.all(images.map(async ({ path, texture }) => {
    const file = graphImageFile(texture);
    if (file) files[path] = new Uint8Array(await file.arrayBuffer());
    else missing.push(path);
  }));
  if (missing.length) showToast(`Exported without ${missing.join(', ')}: the image source is not available`, 'error');
  save(new Blob([zipSync(files)], { type: 'application/zip' }), `${base}.zip`);
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
