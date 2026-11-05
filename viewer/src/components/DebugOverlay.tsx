import { useEffect, useRef, useState } from 'react';
import { Bug, ChevronDown } from 'lucide-react';
import type { EngineDiagnostics, SampleEvent } from '@meimu/mutracer';
import { VIEWER_AOVS, setSettings, setUi, useViewer } from '../store';
import { getEngine, type ViewerEngine } from '../engine/ViewerEngine';
import { Field, Hint, Scrub, Select, Switch } from './ui/controls';

const AOV_LABELS: Record<(typeof VIEWER_AOVS)[number], string> = {
  depth: 'Depth', position: 'Position', roughness: 'Roughness', diffuseAlbedo: 'Diffuse reflectance',
  specularAlbedo: 'Specular reflectance', diffuseColor: 'Diffuse color', specularColor: 'Specular color', id: 'ID', motion: 'Motion'
};

/** Viewport debug card. Collapsed, it shows only the sample time graph. */
export function DebugOverlay() {
  const open = useViewer((s) => s.ui.debug);
  return (
    <div className="float debug-overlay" data-open={open || undefined}>
      <button className="debug-overlay__head" aria-expanded={open} aria-label={open ? 'Hide debug' : 'Show debug'}
        title="Render debug" onClick={() => setUi({ debug: !open })}>
        <Bug size={13} />
        {open && <b>Debug</b>}
        <FrameGraph />
        <span className="toggle-chev"><ChevronDown size={13} /></span>
      </button>
      {open && <DebugControls />}
    </div>
  );
}

const GRAPH_SAMPLES = 40;
const GRAPH_BAR_WIDTH = 1.5;

/** Time per sample of the preview and final renders, drawn like stats.js. */
function FrameGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const times: number[] = [];
    let engine: ViewerEngine | null = null;
    let unsubscribe: (() => void)[] = [];
    let dirty = true;
    const push = (event: SampleEvent) => {
      times.push(event.frameTimeMs);
      if (times.length > GRAPH_SAMPLES) times.shift();
      dirty = true;
    };
    // The engine is created after this effect runs and is replaced on recovery.
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const current = getEngine();
      if (current !== engine) {
        unsubscribe.forEach((off) => off());
        engine = current;
        unsubscribe = engine ? [engine.preview.on('sample', push), engine.final.on('sample', push)] : [];
      }
      const dpr = devicePixelRatio;
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      // The graph narrows when the card collapses.
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; dirty = true; }
      if (!dirty) return;
      dirty = false;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgb(255 255 255 / 0.06)';
      ctx.fillRect(0, 0, width, height);
      // Scale to the median so slow samples (a compile or a preview-to-final
      // switch) saturate instead of flattening the rest.
      const sorted = [...times].sort((a, b) => a - b);
      const max = Math.max(1, sorted[sorted.length >> 1] ?? 0) * 1.35;
      // Fixed bar width: a narrower graph shows only the latest samples.
      const bar = GRAPH_BAR_WIDTH * dpr;
      const shown = times.slice(-Math.floor(width / bar));
      ctx.fillStyle = 'rgb(255 255 255 / 0.85)';
      shown.forEach((t, i) => {
        const h = Math.max(dpr, Math.min(1, t / max) * height);
        ctx.fillRect(width - (shown.length - i) * bar, height - h, bar - dpr * 0.5, h);
      });
      const last = times[times.length - 1];
      valueRef.current!.textContent = last === undefined ? '– ms' : `${last.toFixed(1)} ms`;
    };
    let raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe.forEach((off) => off());
    };
  }, []);
  return (
    <span className="frame-graph">
      <span ref={valueRef} className="mono">– ms</span>
      <canvas ref={canvasRef} aria-hidden="true" />
    </span>
  );
}

function DebugControls() {
  const s = useViewer((state) => state.settings);
  const webgl = useViewer((state) => state.backend.name === 'WebGL 2');
  const jnlm = webgl || s.denoiseModel === 'jnlm';
  return (
    <div className="debug-overlay__body">
      <Field label="Output">
        <Select
          label="Output"
          value={s.output}
          options={[
            { value: 'final', label: 'Final' }, { value: 'albedo', label: 'Albedo' },
            { value: 'normal', label: 'Normal' },
            ...VIEWER_AOVS.map(value => ({value, label: AOV_LABELS[value]}))
          ]}
          onChange={(v) => setSettings({ output: v })}
        />
      </Field>
      {s.output === 'depth' && <Scrub label="Depth range" value={s.aovDepthFar} min={0.01} max={10000} log onChange={(v) => setSettings({aovDepthFar: v})} />}
      {s.output === 'position' && <Scrub label="Position scale" value={s.aovPositionScale} min={0.001} max={10000} log onChange={(v) => setSettings({aovPositionScale: v})} />}
      {s.output === 'motion' && <Scrub label="Motion scale" value={s.aovMotionScale} min={0.01} max={1000} log onChange={(v) => setSettings({aovMotionScale: v})} />}
      {s.output === 'id' && <Field label="ID component"><Select label="ID component" value={s.aovIdComponent} options={(['object', 'instance', 'material', 'primitive'] as const).map(value => ({value, label: value}))} onChange={(v) => setSettings({aovIdComponent: v})} /></Field>}
      {!webgl && <Switch label="Display upscale" checked={s.displayUpscale} onChange={(v) => setSettings({displayUpscale: v})}>
        <span className="field-label">Display upscale</span>
      </Switch>}
      <Switch label="Interactive preview" checked={s.previewEnabled} onChange={(v) => setSettings({ previewEnabled: v })}>
        <span className="field-label">Interactive preview</span>
      </Switch>
      {s.previewEnabled && (
        <Scrub label="Max preview scale" title="Preview scale relative to the full viewport, independent of final resolution" value={s.previewMaxResolutionScale} min={0.25} max={1} onChange={(v) => setSettings({ previewMaxResolutionScale: v })} />
      )}
      {s.denoise && s.denoiseWhileConverging && <Hint>Live denoise also runs while interacting{jnlm ? '.' : ', using the small preview model.'}</Hint>}
      <Diagnostics />
    </div>
  );
}

function Diagnostics() {
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | undefined>();
  useEffect(() => {
    const read = () => setDiagnostics(getEngine()?.engine.getDiagnostics());
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, []);
  if (!diagnostics) return null;
  const shader = diagnostics.shaderCompilation;
  const rows: [string, string][] = [
    ['Backend', `${diagnostics.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${diagnostics.adapterName || 'unknown'}`],
    ['Drawing buffer', `${diagnostics.width} × ${diagnostics.height}`],
    ['Shader compile', shader ? `${Math.round(shader.totalTimeMs ?? 0)} ms · ${shader.sourceLines ?? '?'} lines` : '–'],
    ['Trace time', diagnostics.gpuTraceTiming ? `${diagnostics.gpuTraceTiming.estimatedFullFrameTimeMs?.toFixed(1)} ms / frame` : '–'],
    ['Texture atlas', diagnostics.textureAtlas ? `${diagnostics.textureAtlas.textureCount} textures · ${(diagnostics.textureAtlas.estimatedBytes / 2 ** 20).toFixed(1)} MiB` : '–'],
    ['Emissive triangles', String(diagnostics.lightSampling?.emissiveTriangles ?? 0)]
  ];
  return (
    <dl className="diagnostics">
      {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>))}
    </dl>
  );
}
