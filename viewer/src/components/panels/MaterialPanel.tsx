import { useEffect, useRef, useState } from 'react';
import { FileUp, ImagePlus, MousePointerClick, RotateCcw, X } from 'lucide-react';
import { setUi, showToast, useViewer, type SelectedMaterial } from '../../store';
import { MATERIALX_IMPORT, getEngine } from '../../engine/ViewerEngine';
import { thumbnailUrl } from '../../engine/presets';
import {
  MATERIAL_GROUPS, MATERIAL_PRESET_CATEGORIES, MATERIAL_PRESETS, TEXTURE_SLOTS, hexToLinear, linearToHex,
  type MaterialGroup, type MaterialPresetCategory, type MaterialParam, type MaterialValues, type TextureKey
} from '../../engine/materialParams';
import { ColorField, Hint, NumberField, Scrub, Section, Segmented, Select, Switch } from '../ui/controls';
import { PolyHavenLogo } from '../PolyHavenLogo';
import { toPathedFiles } from '../../engine/droppedFiles';

// Kept across material selections.
let lastPresetCategory: MaterialPresetCategory = 'basic';

export function MaterialPanel() {
  const material = useViewer((s) => s.material);
  const [presetCategory, setPresetCategory] = useState(lastPresetCategory);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const browsing = useViewer((s) => s.ui.textureBrowser);
  const webgl = useViewer((s) => s.backend?.name === 'WebGL 2');

  if (!material) {
    return (
      <div className="empty-panel">
        <MousePointerClick size={22} />
        <strong>No material selected</strong>
        <span>Click an object in the viewport or pick a material in the scene tree.</span>
      </div>
    );
  }

  const set = (values: MaterialValues, label: string, mergeKey?: string) =>
    getEngine()?.setMaterialValues(material.id, values, label, mergeKey);
  const textures = new Set(material.textures);
  const base = material.values.baseColor as [number, number, number];
  const isOpen = (group: MaterialGroup) => {
    if (openGroups[group.id] !== undefined) return openGroups[group.id];
    if (group.id === 'displacement') return true;
    if (!group.weight) return group.id !== 'advanced';
    return Number(material.values[group.weight]) > 0;
  };

  return (
    <>
      <div className="mat-card">
        <i className="mat-ball" style={{ '--c': linearToHex(base) } as React.CSSProperties} />
        <div>
          <strong>{material.name}</strong>
          <small>{material.meshName || 'Mesh'}{material.users > 1 ? ` · shared by ${material.users} meshes` : ''}<MaterialGraphStatus /></small>
        </div>
        <button className="icon-btn sm" title="Reset to loaded values" aria-label="Reset material" onClick={() => getEngine()?.resetMaterial(material.id)}>
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="mat-presets">
        <Segmented label="Preset category" value={presetCategory} options={MATERIAL_PRESET_CATEGORIES}
          onChange={(v) => { lastPresetCategory = v; setPresetCategory(v); }} />
        <div className="preset-grid" aria-label="Material presets">
          {MATERIAL_PRESETS.filter((preset) => preset.category === presetCategory).map((preset) => (
            <button key={preset.id} className="preset" title={`Apply ${preset.label}`} onClick={() => set(preset.values, `${preset.label} preset`)}>
              <img src={thumbnailUrl(`material-${preset.id}`)} alt="" /><span>{preset.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tex-browse hide-m">
        <button className="btn btn--wide" aria-pressed={browsing} data-on={browsing || undefined}
          onClick={() => setUi({ textureBrowser: !browsing })}>
          <PolyHavenLogo />{browsing ? 'Hide Poly Haven textures' : 'Browse Poly Haven textures'}
        </button>
        {MATERIALX_IMPORT && <MaterialXImport materialId={material.id} />}
      </div>
      {MATERIAL_GROUPS.map((group) => {
        const weight = group.weight ? Number(material.values[group.weight]) : undefined;
        return (
          <Section
            key={group.id}
            title={group.label}
            value={weight !== undefined ? formatWeight(weight) : undefined}
            open={isOpen(group)}
            onOpenChange={(open) => setOpenGroups((g) => ({ ...g, [group.id]: open }))}
          >
            {group.params.map((param) => (
              <ParamControl key={param.key} param={param.key === 'displacementScale'
                ? { ...param, ...material.displacementRange } : param.key === 'displacementBias'
                  ? { ...param, ...material.displacementRange, min: -material.displacementRange.max } : param} values={material.values} textures={textures}
                disabled={group.id === 'displacement' && webgl}
                onChange={(values) => set(values, paramLabel(group, param), `${material.id}:${param.key}`)} />
            ))}
            {group.id === 'displacement' && <Hint>{webgl ? 'Displacement requires WebGPU.' :
              'Offset = texture × Scale + Bias, in mesh-local units. Sliders follow object size. Use the numeric inputs to enter any value. A displacement texture is required.'}</Hint>}
          </Section>
        );
      })}
      <Section
        title="Textures"
        value={String(Object.keys(material.maps).length)}
        open={openGroups.textures ?? Object.keys(material.maps).length > 0}
        onOpenChange={(open) => setOpenGroups((g) => ({ ...g, textures: open }))}
      >
        <TextureSlots material={material} />
      </Section>
      {material.textures.length > 0 && <Hint>Values marked with a texture swatch multiply the texture.</Hint>}
    </>
  );
}

/** Picks a MaterialX .zip, or a .mtlx with its textures; folders can be dropped on the viewport. */
function MaterialXImport({ materialId }: { materialId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn btn--wide" disabled={busy} title="A .zip package, or a .mtlx with its texture images. Folders can be dropped on the viewport."
        onClick={() => input.current?.click()}>
        <FileUp size={14} />{busy ? 'Importing MaterialX…' : 'Import MaterialX'}
      </button>
      <input ref={input} type="file" hidden multiple accept=".mtlx,.zip,image/png,image/jpeg,image/webp,image/avif"
        onChange={async (e) => {
          const files = toPathedFiles(e.currentTarget.files ?? []);
          e.currentTarget.value = '';
          if (!files.length) return;
          setBusy(true);
          await getEngine()?.importMaterialX(materialId, files);
          setBusy(false);
        }} />
    </>
  );
}

function ParamControl({
  param, values, textures, onChange, disabled
}: {
  param: MaterialParam;
  values: MaterialValues;
  textures: Set<string>;
  onChange: (values: MaterialValues) => void;
  disabled?: boolean;
}) {
  const badge = 'texture' in param && param.texture && textures.has(param.texture)
    ? <i className="tex" title="Multiplied by a texture" /> : null;
  if (param.kind === 'color') {
    const value = values[param.key] as [number, number, number];
    return <ColorField label={param.label} badge={badge} value={linearToHex(value)} onChange={(hex) => onChange({ [param.key]: hexToLinear(hex) })} />;
  }
  if (param.kind === 'boolean') {
    return (
      <Switch label={param.label} checked={Boolean(values[param.key])} onChange={(v) => onChange({ [param.key]: v })}>
        <span className="field-label">{param.label}</span>
      </Switch>
    );
  }
  return (
    <Scrub
      label={<>{param.label}{badge}</>}
      title={param.key === 'displacementScale' || param.key === 'displacementBias' ? param.key : param.label}
      value={Number(values[param.key])}
      min={param.min}
      max={param.max}
      step={param.step}
      unit={param.unit}
      format={param.key === 'displacementScale' || param.key === 'displacementBias' ? (value) => Number(value.toPrecision(6)).toString() : undefined}
      disabled={disabled}
      onChange={(v) => onChange({ [param.key]: v })}
    />
  );
}

function TextureSlots({ material }: { material: SelectedMaterial }) {
  const webgl = useViewer((s) => s.backend?.name === 'WebGL 2');
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<TextureKey | null>(null);
  const [dropTarget, setDropTarget] = useState<TextureKey | null>(null);
  const wraps = [
    {value:'repeat' as const,label:'Repeat'},
    {value:'clamp-to-edge' as const,label:'Clamp to edge'},
    {value:'mirrored-repeat' as const,label:'Mirrored repeat'}
  ];
  const label = (slot: TextureKey) => TEXTURE_SLOTS.find((s) => s.key === slot)!.label;
  const upload = (slot: TextureKey, file: File | undefined) => {
    if (slot === 'displacementMap' && webgl) return;
    if (!file) return;
    if (!file.type.startsWith('image/')) return showToast(`${file.name} is not an image`, 'error');
    void getEngine()?.setMaterialTexture(material.id, slot, file, `${label(slot)} texture`);
  };
  return (
    <div className="tex-slots">
      {TEXTURE_SLOTS.map(({ key, label, hint }) => {
        const thumb = material.maps[key];
        const has = thumb !== undefined;
        const sampling = material.sampling[key];
        const disabled = key === 'displacementMap' && webgl;
        return (
          <div
            key={key}
            className="tex-slot"
            data-on={has || undefined}
            data-drop={dropTarget === key || undefined}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(key);
            }}
            onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(null);
              upload(key, e.dataTransfer.files[0]);
            }}
          >
            <button className="tex-slot__thumb" title={has ? `Replace ${label.toLowerCase()} texture` : `Upload ${label.toLowerCase()} texture`}
              disabled={key === 'displacementMap' && webgl}
              aria-label={has ? `Replace ${label} texture` : `Upload ${label} texture`}
              onClick={() => { target.current = key; input.current?.click(); }}>
              {thumb ? <img src={thumb} alt="" /> : has ? <i className="tex" /> : <ImagePlus size={14} />}
            </button>
            <span className="tex-slot__label"><b>{label}</b><small>{hint}</small></span>
            {has && (
              <button className="icon-btn icon-btn--bare xs" title={`Remove ${label.toLowerCase()} texture`} aria-label={`Remove ${label} texture`}
                onClick={() => void getEngine()?.setMaterialTexture(material.id, key, null, `Remove ${label.toLowerCase()} texture`)}>
                <X size={12} />
              </button>
            )}
            {sampling && <details className="tex-slot__settings">
              <summary>Wrap &amp; repeat</summary>
              <div role="group" aria-label={`${label} texture sampling`}>
                <div className="tex-slot__wrap">
                  <div className="tex-slot__wrap-axis">
                    <span className="field-label">Wrap S</span>
                    <Select label={`${label} wrap S`} value={sampling.wrapS} options={wraps} disabled={disabled}
                      onChange={wrapS => getEngine()?.setMaterialTextureSampling(material.id,key,{wrapS},`${label} wrap S`)} />
                  </div>
                  <div className="tex-slot__wrap-axis">
                    <span className="field-label">Wrap T</span>
                    <Select label={`${label} wrap T`} value={sampling.wrapT} options={wraps} disabled={disabled}
                      onChange={wrapT => getEngine()?.setMaterialTextureSampling(material.id,key,{wrapT},`${label} wrap T`)} />
                  </div>
                </div>
                <div className="tex-slot__repeat">
                  {[0,1].map(axis => <NumberField key={axis} label={`Repeat ${axis===0?'S':'T'}`} value={sampling.uvScale[axis]} step={.1} disabled={disabled}
                    onChange={value => {
                      const uvScale:[number,number]=[...sampling.uvScale]; uvScale[axis]=value;
                      getEngine()?.setMaterialTextureSampling(material.id,key,{uvScale},`${label} repeat ${axis===0?'S':'T'}`,`${material.id}:${key}:repeat:${axis}`);
                    }} />)}
                </div>
              </div>
            </details>}
          </div>
        );
      })}
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/avif"
        onChange={(e) => {
          if (target.current) upload(target.current, e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }} />
      <Hint>Drop an image on a slot to replace its texture. Edits are kept for this model until another model is opened.</Hint>
    </div>
  );
}

const paramLabel = (group: MaterialGroup, param: MaterialParam) =>
  group.id === 'base' || group.id === 'advanced' ? param.label : `${group.label} ${param.label.toLowerCase()}`;

const formatWeight = (w: number) => (w === 0 ? '0' : w.toFixed(2));

function MaterialGraphStatus(){
  const [state,setState]=useState<ReturnType<NonNullable<ReturnType<typeof getEngine>>['engine']['getDiagnostics']>>();
  useEffect(()=>{const read=()=>setState(getEngine()?.engine.getDiagnostics());read();const timer=setInterval(read,250);return()=>clearInterval(timer);},[]);
  const graph=state?.materialGraphs;
  const details=graph?.diagnostics.map(d=>`${d.node}${d.port?`.${d.port}`:''}: ${d.message}`).join('\n')??'';
  useEffect(()=>{if(details)console.warn(`Material graph diagnostics\n${details}`);},[details]);
  // Ready graphs need no notice; compiling and fallback read as a quiet status.
  if(!graph||(graph.status!=='compiling'&&graph.status!=='failed'))return null;
  const label=graph.status==='compiling'?'compiling graph…':'graph fallback';
  return <span role="status" title={details?`${details}\n(also in the console)`:undefined}>{` · ${label}`}</span>;
}
