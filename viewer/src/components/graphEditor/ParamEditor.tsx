import { useEffect, useState } from 'react';
import { type MaterialGraphInput, type MaterialGraphNode } from '@meimu/mutracer';
import { getEngine } from '../../engine/ViewerEngine';
import { hexToLinear, linearToHex } from '../../engine/materialParams';
import { graphImageName, graphImageTexture } from '../../engine/materialxGraphArchive';
import { ColorField, Select, Switch } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';

const SPACES = ['object', 'world'];
const STRING_OPTIONS: Record<string, string[]> = { space: SPACES, fromspace: ['', ...SPACES], tospace: ['', ...SPACES], uaddressmode: ['periodic'], vaddressmode: ['periodic'], filtertype: ['linear'] };
const LABELS = ['x', 'y', 'z', 'w'];

export function ParamEditor({ port, input, node, materialId, onChange }: {
  port: string; input: MaterialGraphInput; node: MaterialGraphNode; materialId: string;
  onChange: (value: MaterialGraphInput['value']) => void;
}) {
  const { type, value } = input;
  if (value === undefined && type !== 'filename' && type !== 'string') return <span className="gx-param__link">geometry</span>;
  switch (type) {
    case 'float':
    case 'integer':
      return <NumberInput label={port} value={Number(value ?? 0)} step={type === 'integer' ? 1 : 0.01} onChange={v => onChange(type === 'integer' ? Math.round(v) : v)} />;
    case 'boolean':
      return <Switch label={port} checked={Boolean(value)} onChange={onChange} />;
    case 'color3':
    case 'color4': {
      const c = (value as number[]) ?? [0, 0, 0, 1];
      return <span className="gx-param__group">
        <ColorField label={port} value={linearToHex(c.slice(0, 3) as [number, number, number])} onChange={hex => onChange(type === 'color4' ? [...hexToLinear(hex), c[3] ?? 1] : hexToLinear(hex))} />
        {type === 'color4' && <NumberInput label={`${port}.a`} value={c[3] ?? 1} step={0.01} onChange={a => onChange([c[0], c[1], c[2], a])} />}
      </span>;
    }
    case 'vector2':
    case 'vector3':
    case 'vector4': {
      const v = value as number[];
      return <span className="gx-param__group">
        {v.map((x, i) => <NumberInput key={i} label={`${port}.${LABELS[i]}`} value={x} step={0.01} onChange={n => onChange(v.map((old, j) => (j === i ? n : old)))} />)}
      </span>;
    }
    case 'filename': {
      const texture = graphImageTexture(value);
      return <span className="gx-param__link">
        {texture ? graphImageName(texture) ?? 'image' : 'none'}
        <button className="graph-use" onClick={() => pickImage(file => void getEngine()?.setMaterialGraphImage(materialId, node.id, port, file, `${node.category} image`))}>
          {texture ? 'Replace' : 'Load'}
        </button>
      </span>;
    }
    default: {
      const options = STRING_OPTIONS[port];
      if (options) return <Select label={port} value={String(value ?? '')} options={options.map(o => ({ value: o, label: o || 'none' }))} onChange={onChange} />;
      return <TextInput port={port} value={String(value ?? '')} onChange={onChange} />;
    }
  }
}

function TextInput({ port, value, onChange }: { port: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input className="gx-param__text" aria-label={port} value={draft} onChange={e => setDraft(e.currentTarget.value)}
    onBlur={() => { if (draft !== value) onChange(draft); }} onKeyDown={e => {
      if (e.key === 'Enter') { e.stopPropagation(); e.currentTarget.blur(); }
      if (e.key === 'Escape') { e.stopPropagation(); setDraft(value); }
    }} />;
}

function pickImage(onFile: (file: File) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/avif';
  input.onchange = () => { const file = input.files?.[0]; if (file) onFile(file); };
  input.click();
}

