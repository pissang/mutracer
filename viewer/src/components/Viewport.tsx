import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Move, Pause, Play, Repeat as Loop, Upload } from 'lucide-react';
import { MATERIALX_IMPORT, ViewerEngine, getEngine, setEngine } from '../engine/ViewerEngine';
import { HANDOFF_HASH, readDroppedItems, takeStashedFiles } from '../engine/droppedFiles';
import { FOCUS_AREA_SIZE } from '../engine/areaFocus';
import { hashModelPreset, setUi, useViewer } from '../store';
import { MODEL_PRESETS } from '../engine/presets';
import { DebugOverlay } from './DebugOverlay';
import { StatusBar } from './StatusBar';
import { CameraControls } from './ViewControls';
import { Select } from './ui/controls';

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);
  const picking = useViewer((s) => s.pickingFocus);
  const hidden = useViewer((s) => s.ui.hidden);
  const inspectorOpen = useViewer((s) => s.ui.right);

  useEffect(() => {
    const engine = new ViewerEngine(canvasRef.current!);
    setEngine(engine);
    if (location.hash.slice(1).split('&').includes(HANDOFF_HASH)) {
      // Files dropped on the home page (the hash is rewritten after the first settings change).
      void takeStashedFiles().then((files) => {
        if (getEngine() !== engine) return;
        return files ? engine.loadFiles(files) : engine.loadInitialModel(null);
      });
    } else {
      void engine.loadInitialModel(hashModelPreset());
    }
    // Our own hash writes use replaceState, so this only fires for edits by the user.
    const onHashChange = () => void engine.openURL(hashModelPreset());
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      setEngine(null);
      engine.dispose();
    };
  }, []);

  return (
    <section
      className="panel viewport"
      data-picking={picking || undefined}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        const files = await readDroppedItems(e.dataTransfer.items);
        if (files.length) void getEngine()?.loadFiles(files);
      }}
    >
      <canvas ref={canvasRef} className="viewport__canvas" aria-label="Path traced view. Drag to orbit, right-drag to pan, scroll to zoom, click to select." />
      {!hidden && (
        <>
          <SelectionBox />
          <FocusFrame />
          <DebugOverlay />
          <div className="viewport-bottom">
            <Credit />
            <AnimationBar />
            <div className="viewport-footer">
              <StatusBar />
              <CameraControls />
              <button className="btn panel-toggle" aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} aria-expanded={inspectorOpen}
                onClick={() => setUi({ right: !inspectorOpen })}>
                {inspectorOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                <span className="panel-toggle__label"><b>{inspectorOpen ? 'Hide' : 'Show'}</b><small>Panel</small></span>
              </button>
            </div>
          </div>
        </>
      )}
      <LoadingCard />
      {dragging && (
        <div className="drop-layer">
          <div><Upload size={28} />Drop to open<small>.glb · .gltf with .bin and textures · folder · .hdr{MATERIALX_IMPORT && ' · MaterialX .mtlx or .zip'}</small></div>
        </div>
      )}
    </section>
  );
}

/**
 * Autofocus area. Only its center handle intercepts pointer events; the frame
 * and its interior leave the scene available for selection and orbiting.
 */
function FocusFrame() {
  const area = useViewer((s) => s.focusArea);
  const visible = useViewer((s) => s.ui.focusFrame && s.settings.fStop > 0 && s.settings.autoFocus &&
    !(s.settings.cameraIndex < 0 && s.settings.projection === 'orthographic'));
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!visible) {
      drag.current = null;
      setDragging(false);
      setHovered(false);
      return;
    }
    const frame = frameRef.current!;
    const viewport = frame.parentElement!;
    // The frame itself ignores pointer events. Observe the viewport so moving
    // over the canvas can reveal the handle without blocking scene picking.
    const track = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const rect = frame.getBoundingClientRect();
      setHovered(event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom);
    };
    const leave = () => setHovered(false);
    viewport.addEventListener('pointermove', track, { passive: true });
    viewport.addEventListener('pointerleave', leave);
    return () => {
      viewport.removeEventListener('pointermove', track);
      viewport.removeEventListener('pointerleave', leave);
    };
  }, [visible]);
  if (!visible) return null;
  const place = (x: number, y: number) => {
    const clamp = (v: number) => Math.min(0.98, Math.max(0.02, v));
    useViewer.setState((s) => ({ focusArea: {
      ...s.focusArea, x: clamp(x), y: clamp(y)
    } }));
  };
  const endDrag = () => { drag.current = null; setDragging(false); };
  return (
    <div
      ref={frameRef}
      className="focus-frame"
      data-hovered={hovered || undefined}
      data-dragging={dragging || undefined}
      data-status={area.status}
      style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, height: `${FOCUS_AREA_SIZE * 200}%` }}
    >
      {/* Remounts per measurement to replay the focus animation. */}
      <span key={area.attempt} className="focus-frame__marks" data-status={area.status}><i /><i /><i /><i /></span>
      <button
        type="button"
        className="focus-frame__handle"
        aria-label="Move focus area"
        title="Drag to move focus area. Arrow keys move it; Shift moves faster."
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const rect = frameRef.current!.getBoundingClientRect();
          drag.current = { pointerId: e.pointerId, offsetX: e.clientX - (rect.left + rect.width / 2), offsetY: e.clientY - (rect.top + rect.height / 2) };
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const active = drag.current;
          if (!active || e.pointerId !== active.pointerId) return;
          const rect = frameRef.current!.parentElement!.getBoundingClientRect();
          place((e.clientX - active.offsetX - rect.left) / rect.width, (e.clientY - active.offsetY - rect.top) / rect.height);
        }}
        onPointerUp={(e) => { if (e.pointerId === drag.current?.pointerId) endDrag(); }}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.05 : 0.01;
          const offsets: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          const offset = offsets[e.key];
          if (!offset) return;
          e.preventDefault();
          const current = useViewer.getState().focusArea;
          place(current.x + offset[0], current.y + offset[1]);
        }}
      ><Move size={14} aria-hidden="true" /></button>
    </div>
  );
}

function SelectionBox() {
  const rect = useViewer((s) => s.selectionRect);
  if (!rect) return null;
  return (
    <div className="selection" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <i /><i /><i /><i /><span>{rect.label}</span>
    </div>
  );
}

function Credit() {
  const model = useViewer((s) => s.model);
  if (!model?.credit) return null;
  const preset = MODEL_PRESETS.find((p) => p.id === model.presetId);
  return (
    <div className="credit">
      {model.sourceUrl ? <a href={model.sourceUrl} target="_blank" rel="noreferrer">{model.credit}</a> : model.credit}
      {preset?.licenseUrl && <> · <a href={preset.licenseUrl} target="_blank" rel="noreferrer">{preset.license}</a></>}
      {preset?.attributionUrl && <> · <a href={preset.attributionUrl} target="_blank" rel="noreferrer">Credits &amp; changes</a></>}
    </div>
  );
}

function AnimationBar() {
  const anim = useViewer((s) => s.animation);
  if (!anim) return null;
  const engine = getEngine();
  const progress = anim.duration ? anim.time / anim.duration : 0;
  return (
    <div className="float anim">
      <button className="icon-btn play" aria-label={anim.playing ? 'Pause animation' : 'Play animation'} title="Play / pause (Space)"
        onClick={() => engine?.setAnimation({ playing: !anim.playing })}>
        {anim.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <input
        className="timeline"
        type="range"
        aria-label="Animation time"
        min={0}
        max={anim.duration}
        step={0.001}
        value={anim.time}
        style={{ '--p': `${progress * 100}%` } as React.CSSProperties}
        onChange={(e) => engine?.setAnimation({ time: Number(e.currentTarget.value), playing: false })}
      />
      <span className="time mono">{anim.time.toFixed(2)} / {anim.duration.toFixed(2)} s</span>
      <span className="sep" />
      {anim.clips.length > 1 && (
        <Select label="Animation clip" value={String(anim.clip)} options={anim.clips.map((name, i) => ({ value: String(i), label: name }))}
          onChange={(v) => engine?.selectClip(Number(v))} />
      )}
      <Select label="Playback speed" value={String(anim.speed)}
        options={['0.25', '0.5', '1', '2'].map((v) => ({ value: v, label: `${v}×` }))}
        onChange={(v) => engine?.setAnimation({ speed: Number(v) })} />
      <button className="icon-btn icon-btn--bare" aria-label="Loop" aria-pressed={anim.loop} data-active={anim.loop || undefined}
        title="Loop" onClick={() => engine?.setAnimation({ loop: !anim.loop })}><Loop size={14} /></button>
    </div>
  );
}

const STAGES = [
  ['download', 'Download'],
  ['parse', 'Parse glTF'],
  ['bvh', 'Build BVH'],
  ['shaders', 'Compile shaders']
] as const;

function LoadingCard() {
  const loading = useViewer((s) => s.loading);
  if (!loading) return null;
  const current = STAGES.findIndex(([id]) => id === loading.stage);
  const fraction = loading.stage === 'download' && loading.total ? loading.loaded / loading.total : 0;
  const overall = (current + fraction) / STAGES.length;
  return (
    <div className="center-card" role="status" aria-live="polite">
      <h3>Loading {loading.name}</h3>
      <div className="steps">
        {STAGES.map(([id, label], index) => (
          <div key={id} className="step" data-done={index < current || undefined} data-active={index === current || undefined}>
            <span className="dot">{index < current && <Check size={11} />}</span>
            <b>{label}</b>
            <span className="mono">
              {id === 'download' && loading.loaded > 0 ? `${(loading.loaded / 2 ** 20).toFixed(1)}${loading.total ? ` / ${(loading.total / 2 ** 20).toFixed(1)}` : ''} MB` : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="progress"><i style={{ width: `${Math.max(4, overall * 100)}%` }} /></div>
    </div>
  );
}
