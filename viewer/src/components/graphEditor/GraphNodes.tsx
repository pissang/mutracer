import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Texture, type MaterialGraphInput, type MaterialGraphNode, type MaterialGraphType } from '@meimu/mutracer';
import { linearToHex } from '../../engine/materialParams';

export const SURFACE = '__surface';

export interface PortView {
  name: string;
  type: MaterialGraphType;
  /** Authored value or the node default; undefined for implicit geometry inputs. */
  input?: MaterialGraphInput;
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

const round = (v: number) => Number(v.toPrecision(3)).toString();

/** A short, read-only rendering of an unconnected input. */
function Value({ port }: { port: PortView }) {
  const value = port.input?.value;
  if (port.connected) return null;
  if (!port.input || value === undefined) return <span className="gx-value gx-value--muted">{port.type === 'filename' ? 'no image' : 'geometry'}</span>;
  if (value instanceof Texture) return <span className="gx-value">image</span>;
  if ((port.type === 'color3' || port.type === 'color4') && Array.isArray(value))
    return <span className="gx-value"><i className="gx-swatch" style={{ background: linearToHex(value.slice(0, 3) as [number, number, number]) }} /></span>;
  if (Array.isArray(value)) return <span className="gx-value">{value.map(round).join(' ')}</span>;
  if (typeof value === 'number') return <span className="gx-value">{round(value)}</span>;
  return <span className="gx-value">{String(value) || '—'}</span>;
}

/** Last path segment of an imported node ID, e.g. `NG_steel/rust_noise` → `rust_noise`. */
export const shortId = (id: string) => id.slice(id.lastIndexOf('/') + 1);

export const MxNode = memo(function MxNode({ data }: NodeProps<MxFlowNode>) {
  const { node, ports, outputs, errors, unused } = data;
  return (
    <div className="gx-node" data-error={errors.length > 0 || undefined} data-unused={unused || undefined} title={errors.join('\n') || node.id}>
      <header>
        <b>{node.category}</b>
        <small>{node.type}</small>
      </header>
      <div className="gx-node__id">{shortId(node.id)}</div>
      {outputs.map(output => (
        <div key={output.name} className="gx-row gx-row--out" data-type={output.type}>
          <span>{output.name === 'out' ? output.type : output.name}</span>
          <Handle type="source" position={Position.Right} id={output.name} className="gx-handle" />
        </div>
      ))}
      {ports.map(port => (
        <div key={port.name} className="gx-row" data-type={port.type} data-connected={port.connected || undefined}>
          <Handle type="target" position={Position.Left} id={port.name} className="gx-handle" />
          <span>{port.name}</span>
          <Value port={port} />
        </div>
      ))}
    </div>
  );
});

export const SurfaceNode = memo(function SurfaceNode({ data }: NodeProps<SurfaceFlowNode>) {
  return (
    <div className="gx-node gx-node--surface">
      <header><b>OpenPBR surface</b></header>
      {data.terminals.map(terminal => (
        <div key={terminal.name} className="gx-row" data-type={terminal.type} data-connected={terminal.connected || undefined}>
          <Handle type="target" position={Position.Left} id={terminal.name} className="gx-handle" />
          <span>{terminal.name}</span>
        </div>
      ))}
    </div>
  );
});

export const NODE_TYPES = { mx: MxNode, surface: SurfaceNode };
