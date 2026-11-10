import { createContext, memo, useContext, useEffect, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react';
import { type MaterialGraphInput, type MaterialGraphNode, type MaterialGraphType } from '@meimu/mutracer';
import { Select } from '../ui/controls';
import { ParamEditor } from './ParamEditor';

export const GraphEditing = createContext<{
  materialId: string;
  set: (id: string, port: string, value: MaterialGraphInput['value']) => void;
} | null>(null);

export const SURFACE = '__surface';

export interface PortView {
  name: string;
  type: MaterialGraphType;
  /** Authored input or the node default, including implicit geometry inputs. */
  input: MaterialGraphInput;
  connected: boolean;
}

export type MxNodeData = {
  node: MaterialGraphNode;
  ports: PortView[];
  outputs: { name: string; type: MaterialGraphType }[];
  errors: string[];
  unused: boolean;
};
export type SurfaceData = {
  terminals: { name: string; type: MaterialGraphType; connected: boolean }[];
};
export type MxFlowNode = Node<MxNodeData, 'mx'>;
export type SurfaceFlowNode = Node<SurfaceData, 'surface'>;

/** Last path segment of an imported node ID, e.g. `NG_steel/rust_noise` → `rust_noise`. */
export const shortId = (id: string) => id.slice(id.lastIndexOf('/') + 1);

export const MxNode = memo(function MxNode({ id, data }: NodeProps<MxFlowNode>) {
  const { node, ports, outputs, errors, unused } = data;
  const edit = useContext(GraphEditing);
  const update = useUpdateNodeInternals();
  const handleKey = [...outputs.map(p => `out:${p.name}`), ...ports.map(p => `in:${p.name}`)].join('|');
  useEffect(() => { update(id); }, [id, handleKey, update]);
  return (
    <div className="gx-node" data-error={errors.length > 0 || undefined} data-unused={unused || undefined} title={errors.join('\n') || node.id}>
      <header>
        <b>{node.category}</b>
        <small>{node.type}</small>
      </header>
      <div className="gx-node__id">{shortId(node.id)}</div>
      {outputs.map(output => (
        <div key={output.name} title={`${output.name} (${output.type})`} className="gx-row gx-row--out" data-type={output.type}>
          <span>{output.name === 'out' ? output.type : output.name}</span>
          <Handle type="source" position={Position.Right} id={output.name} title={`${output.name} (${output.type})`} aria-label={`${node.category} ${output.name} output (${output.type})`} className="gx-handle" />
        </div>
      ))}
      {ports.map(port => (
        <div key={port.name} title={`${port.name} (${port.type})`} className="gx-row" data-type={port.type} data-connected={port.connected || undefined}>
          <Handle type="target" position={Position.Left} id={port.name} title={`${port.name} (${port.type})`} aria-label={`${node.category} ${port.name} input (${port.type})`} className="gx-handle" />
          <span>{port.name}</span>
          {!port.connected && port.input && edit
            ? <div className="gx-inline nodrag nopan nowheel" onDoubleClick={e => e.stopPropagation()}>
              <ParamEditor port={port.name} input={port.input} node={node} materialId={edit.materialId}
                onChange={value => edit.set(node.id, port.name, value)} />
            </div>
            : null}
        </div>
      ))}
    </div>
  );
});

export const SurfaceNode = memo(function SurfaceNode({ id, data }: NodeProps<SurfaceFlowNode>) {
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const update = useUpdateNodeInternals();
  // Row identities can change without changing node height (e.g. moving a terminal wire).
  useEffect(() => { update(id); }, [id, data.terminals, revealed, update]);
  return (
    <div className="gx-node gx-node--surface">
      <header><b>OpenPBR surface</b></header>
      {/* Retain measurable handles when rows collapse so undo/import never leave an edge without a target. */}
      {data.terminals.map(terminal => {
        const visible = terminal.connected || revealed.has(terminal.name);
        return <div key={terminal.name} title={`${terminal.name} (${terminal.type})`} className="gx-row" data-type={terminal.type}
          data-connected={terminal.connected || undefined} data-hidden={!visible || undefined}>
          <Handle type="target" position={Position.Left} id={terminal.name} isConnectable={visible} title={`${terminal.name} (${terminal.type})`}
            aria-label={`${terminal.name} surface input (${terminal.type})`} className="gx-handle" />
          <span>{terminal.name}</span>
        </div>;
      })}
      <div className="gx-surface-input nodrag nopan nowheel">
        <Select label="Add surface input" value="" options={[
          { value: '', label: 'Add surface input…', disabled: true },
          ...data.terminals.filter(t => !t.connected && !revealed.has(t.name)).map(t => ({ value: t.name, label: `${t.name} · ${t.type}` }))
        ]} onChange={port => { setRevealed(ports => new Set([...ports, port])); }} />
      </div>
    </div>
  );
});

export const NODE_TYPES = { mx: MxNode, surface: SurfaceNode };
