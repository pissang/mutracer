import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, ImagePlus, MousePointerClick, RotateCcw, Unlink, Workflow, X } from 'lucide-react';
import type { MaterialGraphDiagnostic } from '@meimu/mutracer';
import { setUi, showToast, useViewer, type SelectedMaterial } from '../../store';
import { MATERIALX_IMPORT, getEngine } from '../../engine/ViewerEngine';
import { thumbnailUrl } from '../../engine/presets';
import {
  MATERIAL_GROUPS, MATERIAL_PRESET_CATEGORIES, MATERIAL_PRESETS, TEXTURE_SLOTS, hexToLinear, linearToHex,
  type MaterialGroup, type MaterialPresetCategory, type MaterialParam, type MaterialValues, type TextureKey
} from '../../engine/materialParams';
import { ColorField, Hint, NumberField, Scrub, Section, Segmented, Select, Switch } from '../ui/controls';
import { PolyHavenLogo } from '../PolyHavenLogo';
import { readDroppedItems, toPathedFiles } from '../../engine/droppedFiles';
import { isMaterialXDrop, materialDropTarget, TEXTURE_ACCEPT, textureDropError } from '../../engine/materialDrop';

// Kept across material selections.
let lastPresetCategory: MaterialPresetCategory = 'basic';

export function MaterialPanel() {
  const material = useViewer((s) => s.material);
  const [presetCategory, setPresetCategory] = useState(lastPresetCategory);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const browsing = useViewer((s) => s.ui.textureBrowser);
  const materialBrowsing = useViewer((s) => s.ui.materialBrowser);
  const webgl = useViewer((s) => s.backend?.name === 'WebGL 2');
  const [dropping, setDropping] = useState(false);
  const graphState = useGraphDiagnostics();

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
  const driven = new Map(material.graph?.inputs.map(input => [input.key, input]));
  const diagnostics = graphState?.diagnostics ?? [];
  const textureCount = Object.keys(material.maps).length + (material.graph?.images.length ?? 0);
  const base = material.values.baseColor as [number, number, number];
  const isOpen = (group: MaterialGroup) => {
    if (openGroups[group.id] !== undefined) return openGroups[group.id];
    if (group.id === 'displacement') return true;
    if (!group.weight) return group.id !== 'advanced';
    return Number(material.values[group.weight]) > 0;
  };

  return (
    <div className="material-panel" data-drop={dropping || undefined}
      onDropCapture={() => setDropping(false)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={async (e) => {
        e.preventDefault();
        setDropping(false);
        const target = materialDropTarget('panel', null, { materialId: material.id, objectId: null, name: material.name });
        try {
          const files = await readDroppedItems(e.dataTransfer.items);
          if (MATERIALX_IMPORT && isMaterialXDrop(files)) await getEngine()?.importMaterialX(target!.materialId, files);
          else showToast('Drop a MaterialX package here, or an image on a texture slot', 'error');
        } catch (error) { showToast(`Could not read dropped files: ${(error as Error).message}`, 'error'); }
      }}>
      <div className="mat-card">
        <i className="mat-ball" style={{ '--c': linearToHex(base) } as React.CSSProperties} />
        <div>
          <strong>{material.name}</strong>
          <small>{material.meshName || 'Mesh'}{material.users > 1 ? ` · shared by ${material.users} meshes` : ''}<MaterialGraphStatus state={graphState} /></small>
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
        <button className="btn" aria-pressed={browsing} data-on={browsing || undefined}
          title={browsing ? 'Hide Poly Haven textures' : 'Browse Poly Haven textures'}
          onClick={() => setUi({ textureBrowser: !browsing, materialBrowser: false })}>
          <PolyHavenLogo />Poly Haven
        </button>
        {MATERIALX_IMPORT && <>
          <button className="btn" aria-pressed={materialBrowsing} data-on={materialBrowsing || undefined}
            title={materialBrowsing ? 'Hide GPUOpen materials' : 'Browse GPUOpen MaterialX materials'}
            onClick={() => setUi({ materialBrowser: !materialBrowsing, textureBrowser: false })}>
            <Download size={14} />GPUOpen
          </button>
          <MaterialXImport materialId={material.id} />
        </>}
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
                graph={driven.get(param.key)} fallback={webgl && !material.graph?.webgl}
                onChange={(values) => set(values, paramLabel(group, param), `${material.id}:${param.key}`)} />
            ))}
            {group.id === 'displacement' && <Hint>{webgl ? 'Displacement requires WebGPU.' :
              'Offset = texture × Scale + Bias, in mesh-local units. Sliders follow object size. Use the numeric inputs to enter any value. A displacement texture is required.'}</Hint>}
          </Section>
        );
      })}
      {material.graph && material.graph.inputs.length > 0 && <Section
        title="Graph"
        value={String(material.graph.inputs.length)}
        open={openGroups.graph ?? true}
        onOpenChange={(open) => setOpenGroups((g) => ({ ...g, graph: open }))}
      >
        <GraphInputs material={material} diagnostics={diagnostics} />
      </Section>}
      <Section
        title="Textures"
        value={String(textureCount)}
        open={openGroups.textures ?? textureCount > 0}
        onOpenChange={(open) => setOpenGroups((g) => ({ ...g, textures: open }))}
      >
        {material.graph && material.graph.images.length > 0 && <GraphImages material={material} diagnostics={diagnostics} />}
        <TextureSlots material={material} />
      </Section>
      {material.textures.length > 0 && <Hint>Values marked with a texture swatch multiply the texture.</Hint>}
    </div>
  );
}

/** Picks a MaterialX .zip, or a .mtlx with its textures; folders can be dropped on the viewport. */
function MaterialXImport({ materialId }: { materialId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn" disabled={busy} title="Import MaterialX: a .zip package, or a .mtlx with its texture images. Folders can be dropped on the viewport."
        onClick={() => input.current?.click()}>
        <FileUp size={14} />{busy ? 'Importing…' : 'MaterialX'}
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
  param, values, textures, onChange, disabled, graph, fallback
}: {
  param: MaterialParam;
  values: MaterialValues;
  textures: Set<string>;
  onChange: (values: MaterialValues) => void;
  disabled?: boolean;
  /** Set when the material graph drives this input. */
  graph?: GraphInput;
  /** The backend renders the material value in place of the graph, so the control stays live. */
  fallback?: boolean;
}) {
  const badge = graph ? <GraphBadge input={graph} fallback={fallback} />
    : 'texture' in param && param.texture && textures.has(param.texture)
      ? <i className="tex" title="Multiplied by a texture" /> : null;
  disabled = disabled || (!!graph && !fallback);
  if (param.kind === 'color') {
    const value = values[param.key] as [number, number, number];
    return <ColorField label={param.label} badge={badge} value={linearToHex(value)} disabled={disabled} onChange={(hex) => onChange({ [param.key]: hexToLinear(hex) })} />;
  }
  if (param.kind === 'boolean') {
    return (
      <Switch label={param.label} checked={Boolean(values[param.key])} disabled={disabled} onChange={(v) => onChange({ [param.key]: v })}>
        <span className="field-label">{param.label}{badge}</span>
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
    const error = textureDropError([file]);
    if (error) return showToast(error, 'error');
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
              if (!disabled) setDropTarget(key);
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === key ? null : t)); }}
            onDrop={(e) => {
              setDropTarget(null);
              // MaterialX packages (including texture sidecars) belong to the panel.
              if (isMaterialXDrop(toPathedFiles(e.dataTransfer.files)) || Array.from(e.dataTransfer.items).some(i => i.webkitGetAsEntry?.()?.isDirectory)) return;
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(null);
              if (disabled) return showToast('Displacement requires WebGPU', 'error');
              const error = textureDropError(Array.from(e.dataTransfer.files));
              if (error) return showToast(error, 'error');
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
      <input ref={input} type="file" hidden accept={TEXTURE_ACCEPT}
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

type GraphInput = NonNullable<SelectedMaterial['graph']>['inputs'][number];
type GraphState = NonNullable<ReturnType<NonNullable<ReturnType<typeof getEngine>>['engine']['getDiagnostics']>>['materialGraphs'];

/** Engine-wide graph compilation state, refreshed whenever the selection or render phase changes. */
function useGraphDiagnostics(){
  const [state,setState]=useState<GraphState>();
  const material = useViewer(s => s.material);
  const phase = useViewer(s => s.stats.phase);
  useEffect(() => {
    const controller = new AbortController();
    // The viewer commits material edits on its next frame. Follow replacements
    // through the wait result, without polling compilation diagnostics.
    let frame = 0;
    const follow = () => {
      frame = requestAnimationFrame(() => {
        const engine = getEngine()?.engine;
        if (!engine || controller.signal.aborted) return;
        setState(engine.getDiagnostics()?.materialGraphs);
        void engine.waitForMaterialGraphs({signal: controller.signal}).then(result => {
          if (controller.signal.aborted) return;
          setState(engine.getDiagnostics()?.materialGraphs);
          if (result.outcome === 'superseded') follow();
        });
      });
    };
    follow();
    return () => {controller.abort(); cancelAnimationFrame(frame);};
  }, [material, phase]);
  return state;
}

function MaterialGraphStatus({state:graph}:{state:GraphState}){
  const details=graph?.diagnostics.map(d=>`${d.node}${d.port?`.${d.port}`:''}: ${d.message}`).join('\n')??'';
  useEffect(()=>{if(details)console.warn(`Material graph diagnostics\n${details}`);},[details]);
  // Ready graphs need no notice; compiling and fallback read as a quiet status.
  if(!graph||(graph.status!=='compiling'&&graph.status!=='failed'))return null;
  const label=graph.status==='compiling'?'compiling graph…':'graph fallback';
  return <span role="status" title={details?`${details}\n(also in the console)`:undefined}>{` · ${label}`}</span>;
}

const messages = (list: MaterialGraphDiagnostic[]) => [...new Set(list.map(d => d.message))];

function GraphBadge({ input, fallback }: { input: GraphInput; fallback?: boolean }) {
  return <i className="graph-badge" title={`Graph: ${input.source}${fallback ? ' (WebGPU only)' : ''}`}><Workflow size={10} /></i>;
}

const PARAM_LABELS = new Map(MATERIAL_GROUPS.flatMap(group => group.params.map(param => [param.key as string, paramLabel(group, param)])));
const inputLabel = (key: string) => PARAM_LABELS.get(key)
  ?? key.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`).replace(/^./, c => c.toUpperCase());

/** Graph-driven inputs, including those without a control; disconnecting hands an input back to its control. */
function GraphInputs({ material, diagnostics }: { material: SelectedMaterial; diagnostics: MaterialGraphDiagnostic[] }) {
  return (
    <div className="graph-inputs">
      {material.graph!.inputs.map(input => {
        const nodes = new Set(input.nodes);
        const errors = messages(diagnostics.filter(d => d.node ? nodes.has(d.node) : d.port === input.terminal));
        const label = inputLabel(input.key);
        return (
          <div key={input.terminal} className="graph-input" data-error={errors.length > 0 || undefined}>
            <span><b>{label}</b><small title={input.source}>{input.source}</small></span>
            <button className="icon-btn icon-btn--bare xs" title={`Disconnect ${label.toLowerCase()} from the graph`} aria-label={`Disconnect ${label}`}
              onClick={() => getEngine()?.disconnectMaterialGraphInput(material.id, input.terminal, `Disconnect ${label.toLowerCase()}`)}>
              <Unlink size={12} />
            </button>
            {errors.map(message => <small key={message} className="graph-error">{message}</small>)}
          </div>
        );
      })}
    </div>
  );
}

/** Images read by the material graph; replacing one keeps its color space and UV settings. */
function GraphImages({ material, diagnostics }: { material: SelectedMaterial; diagnostics: MaterialGraphDiagnostic[] }) {
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<{ node: string; port: string; name: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const replace = (image: { node: string; port: string; name: string }, file: File | undefined) => {
    if (!file) return;
    const error = textureDropError([file]);
    if (error) return showToast(error, 'error');
    void getEngine()?.setMaterialGraphImage(material.id, image.node, image.port, file, `Replace ${image.name}`);
  };
  return (
    <div className="tex-slots">
      {material.graph!.images.map(image => {
        const errors = messages(diagnostics.filter(d => d.node === image.node));
        return (
          <div key={`${image.node}.${image.port}`} className="tex-slot" data-on data-drop={dropTarget === image.node || undefined}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropTarget(image.node); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(t => (t === image.node ? null : t)); }}
            onDrop={(e) => {
              setDropTarget(null);
              if (isMaterialXDrop(toPathedFiles(e.dataTransfer.files))) return;
              e.preventDefault();
              e.stopPropagation();
              replace(image, e.dataTransfer.files[0]);
            }}>
            <button className="tex-slot__thumb" title={`Replace ${image.name}`} aria-label={`Replace ${image.name}`}
              onClick={() => { target.current = image; input.current?.click(); }}>
              {image.thumb ? <img src={image.thumb} alt="" /> : <i className="tex" />}
            </button>
            <span className="tex-slot__label">
              <b title={image.node}>{image.name}</b>
              <small>{image.feeds.map(inputLabel).join(', ')}</small>
            </span>
            <span />
            {errors.map(message => <small key={message} className="graph-error">{message}</small>)}
          </div>
        );
      })}
      <input ref={input} type="file" hidden accept={TEXTURE_ACCEPT}
        onChange={(e) => {
          if (target.current) replace(target.current, e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }} />
    </div>
  );
}
