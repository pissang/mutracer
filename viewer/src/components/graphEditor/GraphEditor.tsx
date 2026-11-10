import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, useReactFlow,
  type Connection, type Edge as FlowEdge, type EdgeChange, type IsValidConnection, type NodeChange, type OnSelectionChangeParams
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './graphEditor.css';
import { Download, LayoutGrid, Plus, Trash2 } from 'lucide-react';
import { zipSync, strToU8 } from 'fflate';
import { MaterialGraph, Texture, type MaterialGraphConnection, type MaterialGraphDiagnostic, type MaterialGraphInput, type MaterialGraphNode, type MaterialGraphType } from '@meimu/mutracer';
import { showToast, useViewer, type SelectedMaterial } from '../../store';
import { getEngine } from '../../engine/ViewerEngine';
import {
  PALETTE, TERMINALS, addNode, canonicalTerminal, categoryTypes, connect, connectionError, disconnect, layoutGraph, nodeOutputs, nodePorts,
  reachable, reconnect, removeNodes, removeUnused, setNodeType, setParameter, type Target
} from '../../engine/graphEdit';
import { exportMaterialX } from '../../engine/materialxExport';
import { graphImageFile, graphImageName } from '../../engine/materialxGraphArchive';
import { hexToLinear, linearToHex } from '../../engine/materialParams';
import { normalizeGraph } from '../../../../src/renderer/materialGraph/normalize';
import { outputType } from '../../../../src/renderer/materialGraph/nodes';
import { ColorField, Select, Switch } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { useGraphDiagnostics } from '../panels/MaterialPanel';
import { NODE_TYPES, SURFACE, shortId, type MxFlowNode, type PortView, type SurfaceFlowNode } from './GraphNodes';

type FlowNode = MxFlowNode | SurfaceFlowNode;
const EMPTY = new MaterialGraph();

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
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const lastRejection = useRef<string | null>(null);
  const [layoutRun, setLayoutRun] = useState(0);

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
    setNodes(prev => {
      const old = new Map(prev.map(n => [n.id, n]));
      const connectedTerminals = new Set(Object.entries(graph.terminal).filter(([, e]) => e).map(([name]) => canonicalTerminal(name)));
      const surface: SurfaceFlowNode = {
        ...(old.get(SURFACE) as SurfaceFlowNode | undefined), id: SURFACE, type: 'surface', position: place(SURFACE), deletable: false,
        data: { terminals: TERMINALS.map(([name, type]) => ({ name, type, connected: connectedTerminals.has(name) })) }
      };
      const items: FlowNode[] = graph.nodes.map(node => {
        const ports = nodePorts(node);
        const view: PortView[] = Object.entries(ports).map(([name, def]) => {
          const authored = node.inputs?.[name];
          return { name, type: authored?.type ?? def.type, input: authored ?? (def.value !== undefined ? def : undefined), connected: !!authored?.connection };
        });
        return {
          ...(old.get(node.id) as MxFlowNode | undefined), id: node.id, type: 'mx', position: place(node.id),
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
        list.push({ ...old.get(id), id, source: source.node, sourceHandle: source.output ?? 'out', target, targetHandle: handle, className: `gx-edge gx-edge--${type ?? 'float'}` });
      };
      for (const node of graph.nodes) for (const [port, input] of Object.entries(node.inputs ?? {}))
        if (input.connection) add(`${node.id}\u0000${port}`, input.connection, node.id, port, input.type);
      for (const [name, edge] of Object.entries(graph.terminal)) if (edge) {
        const canonical = canonicalTerminal(name);
        add(`${SURFACE}\u0000${canonical}`, edge, SURFACE, canonical, TERMINALS.find(([t]) => t === canonical)?.[1]);
      }
      return list;
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

  // Dropping a reconnected edge on empty canvas disconnects it.
  const reconnected = useRef(false);
  const onReconnect = useCallback((edge: FlowEdge, c: Connection) => {
    reconnected.current = true;
    try {
      commit(reconnect(graph, sourceOf(c.source, c.sourceHandle), targetOf(edge.target, edge.targetHandle), targetOf(c.target, c.targetHandle)), 'Rewire connection');
      setRejected(null);
    } catch (error) { setRejected((error as Error).message); }
  }, [graph, commit]);
  const onReconnectEnd = useCallback((_: unknown, edge: FlowEdge) => {
    if (!reconnected.current) commit(disconnect(graph, targetOf(edge.target, edge.targetHandle)), 'Disconnect');
    reconnected.current = false;
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

  const add = (category: string) => {
    const { graph: next, id } = addNode(graph, category);
    const box = document.querySelector('.graph-editor__canvas')?.getBoundingClientRect();
    const center = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 3 }) : { x: 0, y: 0 };
    positions.current.set(id, { x: center.x - 100, y: center.y });
    commit(next, `Add ${category}`);
    setSelected(id);
  };

  const relayout = () => {
    positions.current.clear();
    setNodes([]);
    setLayoutRun(run => run + 1);
    // The rebuild effect places every node again; fit once they are measured.
    setTimeout(() => void flow.fitView({ padding: 0.1, duration: 200 }), 80);
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
        <Palette onAdd={add} />
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
        <div className="graph-editor__canvas">
          <ReactFlow<FlowNode>
            nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} colorMode="dark"
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={isValidConnection}
            onConnectEnd={() => { if (lastRejection.current) setRejected(lastRejection.current); lastRejection.current = null; }}
            onReconnect={onReconnect} onReconnectStart={() => { reconnected.current = false; }} onReconnectEnd={onReconnectEnd}
            onDelete={onDelete} onSelectionChange={onSelectionChange}
            deleteKeyCode={['Backspace', 'Delete']} fitView fitViewOptions={{ padding: 0.1 }} minZoom={0.1} maxZoom={2}
            proOptions={{ hideAttribution: true }}>
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {selectedNode && <Inspector key={selectedNode.id} node={selectedNode} graph={graph} material={material} commit={commit} />}
      </div>
    </>
  );
}

const describe = (d: MaterialGraphDiagnostic) => `${d.node ? shortId(d.node) : ''}${d.port ? `.${d.port}` : ''}${d.node || d.port ? ': ' : ''}${d.message}`;

/** Searchable list of the engine's node categories. */
function Palette({ onAdd }: { onAdd: (category: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, string[]>();
    for (const entry of PALETTE) if (!q || entry.category.includes(q)) map.set(entry.group, [...(map.get(entry.group) ?? []), entry.category]);
    return [...map.entries()];
  }, [query]);
  return (
    <div className="gx-palette">
      <button className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}><Plus size={13} />Node</button>
      {open && <div className="gx-palette__menu" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
        <input autoFocus placeholder="Search nodes" aria-label="Search nodes" value={query} onChange={e => setQuery(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return;
            const q = query.trim().toLowerCase(), all = groups.flatMap(([, list]) => list);
            const pick = all.find(c => c === q) ?? all.find(c => c.startsWith(q)) ?? all[0];
            if (pick) { onAdd(pick); setOpen(false); setQuery(''); }
          }} />
        <div className="gx-palette__list">
          {groups.map(([group, categories]) => (
            <div key={group}>
              <small>{group}</small>
              {categories.map(category => <button key={category} onClick={() => { onAdd(category); setOpen(false); setQuery(''); }}>{category}</button>)}
            </div>
          ))}
        </div>
      </div>}
    </div>
  );
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
              : <ParamEditor port={port} input={input} node={node} material={material} onChange={value => set(port, value)} />}
            {authored && !authored.connection && <button className="gx-param__reset" title="Restore the default" aria-label={`Reset ${port}`} onClick={() => set(port, undefined)}>↺</button>}
          </div>
        );
      })}
    </aside>
  );
}

const SPACES = ['object', 'world'];
const STRING_OPTIONS: Record<string, string[]> = { space: SPACES, fromspace: ['', ...SPACES], tospace: ['', ...SPACES], uaddressmode: ['periodic'], vaddressmode: ['periodic'], filtertype: ['linear'] };
const LABELS = ['x', 'y', 'z', 'w'];

function ParamEditor({ port, input, node, material, onChange }: {
  port: string; input: MaterialGraphInput; node: MaterialGraphNode; material: SelectedMaterial;
  onChange: (value: MaterialGraphInput['value']) => void;
}) {
  const { type, value } = input;
  if (value === undefined && type !== 'filename' && type !== 'string') return <span className="gx-param__link">geometry</span>;
  switch (type) {
    case 'float':
    case 'integer':
      return <NumberInput label="" value={Number(value ?? 0)} step={type === 'integer' ? 1 : 0.01} onChange={v => onChange(type === 'integer' ? Math.round(v) : v)} />;
    case 'boolean':
      return <Switch label={port} checked={Boolean(value)} onChange={onChange} />;
    case 'color3':
    case 'color4': {
      const c = (value as number[]) ?? [0, 0, 0, 1];
      return <span className="gx-param__group">
        <ColorField label="" value={linearToHex(c.slice(0, 3) as [number, number, number])} onChange={hex => onChange(type === 'color4' ? [...hexToLinear(hex), c[3] ?? 1] : hexToLinear(hex))} />
        {type === 'color4' && <NumberInput label="a" value={c[3] ?? 1} step={0.01} onChange={a => onChange([c[0], c[1], c[2], a])} />}
      </span>;
    }
    case 'vector2':
    case 'vector3':
    case 'vector4': {
      const v = value as number[];
      return <span className="gx-param__group">
        {v.map((x, i) => <NumberInput key={i} label={LABELS[i]} value={x} step={0.01} onChange={n => onChange(v.map((old, j) => (j === i ? n : old)))} />)}
      </span>;
    }
    case 'filename': {
      const texture = value instanceof Texture ? value : undefined;
      return <span className="gx-param__link">
        {texture ? graphImageName(texture) ?? 'image' : 'none'}
        <button className="graph-use" onClick={() => pickImage(file => void getEngine()?.setMaterialGraphImage(material.id, node.id, port, file, `${shortId(node.id)} image`))}>
          {texture ? 'Replace' : 'Load'}
        </button>
      </span>;
    }
    default: {
      const options = STRING_OPTIONS[port];
      if (options) return <Select label={port} value={String(value ?? '')} options={options.map(o => ({ value: o, label: o || 'none' }))} onChange={onChange} />;
      return <input className="gx-param__text" aria-label={port} defaultValue={String(value ?? '')} onBlur={e => onChange(e.currentTarget.value)} />;
    }
  }
}

function pickImage(onFile: (file: File) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/avif';
  input.onchange = () => { const file = input.files?.[0]; if (file) onFile(file); };
  input.click();
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
