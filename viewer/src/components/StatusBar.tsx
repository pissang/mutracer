import { Button, Dialog, DialogTrigger, Heading, Popover } from 'react-aria-components';
import { Check, Pause, Play, SlidersHorizontal, X } from 'lucide-react';
import { VIEWER_AOVS, setSettings, useViewer, type RenderPhase } from '../store';
import { Field, Select, Switch } from './ui/controls';
import { ResolutionSelect } from './ResolutionSelect';
import { ViewControls } from './ViewControls';

const LABELS: Record<RenderPhase, string> = {
  starting: 'Starting',
  preparing: 'Preparing',
  compiling: 'Compiling',
  previewing: 'Preview',
  converging: 'Converging',
  denoising: 'Denoising',
  finished: 'Done',
  paused: 'Paused',
  error: 'Error'
};

const SAMPLE_STEPS = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];

function formatTime(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

/** Circular sample progress. Denoising and loading phases spin. */
function ProgressRing({ progress, phase }: { progress: number; phase: RenderPhase }) {
  const r = 10;
  const c = 2 * Math.PI * r;
  const spinning = phase === 'previewing' || phase === 'denoising' || phase === 'preparing' || phase === 'compiling' || phase === 'starting';
  return (
    <span className="ring" data-phase={phase} data-spinning={spinning || undefined}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Sample progress">
      <svg className="ring__svg" viewBox="0 0 26 26" aria-hidden>
        <circle className="ring__track" cx="13" cy="13" r={r} />
        <circle
          className="ring__arc" cx="13" cy="13" r={r}
          strokeDasharray={c}
          strokeDashoffset={spinning ? c * 0.72 : c * (1 - Math.min(1, progress))}
        />
      </svg>
      {phase === 'converging' && <span className="ring__pct">{Math.floor(progress * 100)}</span>}
      {phase === 'finished' && <Check size={13} strokeWidth={3.25} />}
      {phase === 'paused' && <Pause size={11} strokeWidth={3} />}
    </span>
  );
}

/**
 * Bottom dock: progress and the render settings people change most.
 * Everything else lives in the Render tab. The status block has a fixed
 * width so neighboring controls stay steady while numbers change.
 */
export function StatusBar() {
  const stats = useViewer((s) => s.stats);
  const settings = useViewer((s) => s.settings);
  const paused = useViewer((s) => s.paused);
  const playing = useViewer((s) => s.animation?.playing ?? false);
  const { phase, samples, elapsed, msPerSample } = stats;
  const { maxSamples } = settings;
  const sampleTarget = settings.output === 'id' || settings.output === 'motion' ? 1
    : VIEWER_AOVS.some(kind => kind === settings.output) ? Math.min(maxSamples, 16) : maxSamples;
  const progress = Math.min(1, samples / sampleTarget);
  const done = phase === 'finished' || phase === 'paused';
  const remaining = phase === 'converging' && samples > 4 ? ((sampleTarget - samples) * msPerSample) / 1000 : 0;
  const time = done ? formatTime(elapsed) : remaining > 0.5 ? `~${formatTime(remaining)}` : '';
  const sampleOptions = [...new Set([...SAMPLE_STEPS, maxSamples])].sort((a, b) => a - b);
  const denoise = settings.denoise;

  return (
    <div className="float dock" role="status" data-phase={phase}>
      <ViewControls />
      <div className="dock__summary">
        <ProgressRing progress={progress} phase={phase} />
        <div className="dock__status" title={done && msPerSample ? `${elapsed.toFixed(1)} s · ${msPerSample.toFixed(1)} ms per sample` : undefined}>
          <b>{playing && (phase === 'previewing' || phase === 'converging') ? 'Playing' : LABELS[phase]}</b>
          <span className="mono"><span className="dock__spp">{samples}</span><span className="dock__unit"> spp</span>{time && <span className="dock__time"> · {time}</span>}</span>
        </div>
        {phase !== 'finished' && <button className="icon-btn icon-btn--bare dock__pause" aria-label={paused ? 'Resume rendering' : 'Pause rendering'}
          title={paused ? 'Resume (Space)' : 'Pause accumulation (Space)'} data-active={paused || undefined}
          onClick={() => useViewer.setState({ paused: !paused })}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>}
      </div>
      <span className="sep" />
      <div className="dock__settings">
        <Select
          label="Max samples"
          prefix="Samples"
          value={String(maxSamples)}
          options={sampleOptions.map((v) => ({ value: String(v), label: String(v) }))}
          onChange={(v) => setSettings({ maxSamples: Number(v) })}
        />
        <ResolutionSelect prefix="Res" />
        <div className="dock__denoise">
          <label
            className="dock__toggle"
            data-selected={denoise || undefined}
            title="Denoise (D)"
          >
            <input
              type="checkbox"
              checked={denoise}
              onChange={(e) => setSettings({ denoise: e.currentTarget.checked })}
            />
            <span className="dock__label">Denoise</span>
          </label>
          {denoise && <DenoiserSelect />}
          {denoise && <label
            className="dock__toggle"
            data-selected={settings.denoiseWhileConverging || undefined}
            title="Denoise while converging: previews and every few samples, not only the final image"
          >
            <input
              type="checkbox"
              aria-label="Live denoise"
              checked={settings.denoiseWhileConverging}
              onChange={(e) => setSettings({ denoiseWhileConverging: e.currentTarget.checked })}
            />
            <span className="dock__label">Live</span>
          </label>}
        </div>
        <RenderSettingsPopover />
      </div>
    </div>
  );
}

function DenoiserSelect({ disabled = false }: { disabled?: boolean }) {
  const settings = useViewer((s) => s.settings);
  const webgl = useViewer((s) => s.backend.name === 'WebGL 2');
  return <Select
    label="Denoiser type"
    disabled={disabled}
    value={webgl || settings.denoiseModel === 'jnlm' ? 'jnlm' : 'oidn'}
    options={[
      { value: 'oidn', label: 'OIDN', disabled: webgl, hint: webgl ? 'Requires WebGPU' : undefined },
      { value: 'jnlm', label: 'JNLM' }
    ]}
    onChange={(v) => setSettings({ denoiseModel: v === 'jnlm' ? 'jnlm' : settings.oidnModel })}
  />;
}

function RenderSettingsPopover() {
  const settings = useViewer((s) => s.settings);
  return (
    <DialogTrigger>
      <Button className="icon-btn dock__more" aria-label="Render settings"><SlidersHorizontal size={14} /></Button>
      <Popover className="popover dock-options" placement="top end" offset={8}>
        <Dialog aria-label="Render settings">
          {({ close }) => <>
            <Heading slot="title" className="dialog__title">Render settings
              <button className="icon-btn icon-btn--bare xs" aria-label="Close render settings" onClick={close}><X size={12} /></button>
            </Heading>
            <Switch label="Denoise" checked={settings.denoise} onChange={(v) => setSettings({ denoise: v })}>
              <span className="field-label">Denoise</span>
            </Switch>
            <Field label="Denoiser"><DenoiserSelect disabled={!settings.denoise} /></Field>
            <Switch label="Live denoise" checked={settings.denoiseWhileConverging} disabled={!settings.denoise}
              onChange={(v) => setSettings({ denoiseWhileConverging: v })}>
              <span className="field-label">Live denoise</span>
            </Switch>
          </>}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
