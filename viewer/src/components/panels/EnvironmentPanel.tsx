import { useId } from 'react';
import { Button, FileTrigger } from 'react-aria-components';
import { Globe, Image, Lamp, Square, Sun, Upload } from 'lucide-react';
import { autoGroundedSkybox, setSettings, useViewer } from '../../store';
import { ENVIRONMENT_PRESETS, ENV_RESOLUTIONS } from '../../engine/presets';
import { STUDIO_PRESETS, findStudioPreset, type StudioPreset } from '../../engine/studio';
import { getEngine } from '../../engine/ViewerEngine';
import { toPathedFiles } from '../../engine/loadModel';
import { ColorField, Field, Hint, Scrub, Section, Segmented, Switch } from '../ui/controls';
import { SunTime } from './SunTime';

const formatMB = (bytes: number) => (bytes / 1048576).toFixed(1);

const SKY_SWATCH = 'linear-gradient(180deg,#3c6fc4 0%,#b9c9dc 48%,#5a524b 52%,#2b2725 100%)';

export function EnvironmentPanel() {
  const s = useViewer((state) => state.settings);
  const envLoading = useViewer((state) => state.envLoading);
  const modelRadius = useViewer((state) => state.modelRadius);
  const modelLighting = useViewer((state) => state.modelLighting);
  const grounded = autoGroundedSkybox(modelRadius, s.groundedHeight);
  const groundedAuto = s.groundedHeight === null && s.groundedRadius === null;
  const loadingFraction = envLoading?.total ? envLoading.loaded / envLoading.total : 0;
  const current = ENVIRONMENT_PRESETS.find((p) => p.id === s.envId);
  const studio = s.lighting === 'studio';
  const thumb = studio ? STUDIO_SWATCH : current?.thumbnail ? `url(${current.thumbnail}) center/cover` : SKY_SWATCH;
  const backgrounds = ([
    ['environment', studio ? 'Studio' : 'HDRI', { background: thumb }],
    ['grounded', 'Grounded', { background: thumb }],
    ['color', 'Color', { background: s.backgroundColor }],
    ['transparent', 'Transparent', undefined]
  ] as const).filter(([id]) => !studio || id !== 'grounded');
  // Grounded projection needs an HDRI; studio mode shows its backdrop instead.
  const background = studio && s.background === 'grounded' ? 'environment' : s.background;
  return (
    <>
      <div className="lighting-mode">
        <Segmented
          label="Lighting"
          value={s.lighting}
          options={[
            { value: 'environment', label: <><Globe size={13} />Environment</> },
            { value: 'studio', label: <><Lamp size={13} />Studio</> }
          ]}
          onChange={(v) => setSettings({ lighting: v })}
        />
      </div>

      {studio ? <StudioSection /> : <Section
        title="Environment"
        icon={<Globe size={14} />}
        value={envLoading ? `Loading ${Math.round(loadingFraction * 100)}%` : s.envId === 'model' ? 'Scene lighting' : current?.name ?? 'Custom HDR'}
      >
        <div className="env-grid" role="radiogroup" aria-label="Environment map">
          {modelLighting?.available && <button className="env env--upload" role="radio" aria-checked={s.envId === 'model'}
            data-on={s.envId === 'model' || undefined} onClick={() => setSettings({ envId: 'model', envIntensity: 1, envRotation: 0 })}>
            <div><Sun size={16} />Scene lighting</div>
          </button>}
          {ENVIRONMENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="env"
              role="radio"
              aria-checked={s.envId === preset.id}
              data-on={s.envId === preset.id || undefined}
              style={{ background: preset.thumbnail ? `#222 url(${preset.thumbnail}) center/cover` : SKY_SWATCH }}
              onClick={() => setSettings({ envId: preset.id })}
            >
              <span>{preset.name}</span>
              {envLoading?.id === preset.id && <i className="env__bar" style={{ width: `${Math.max(4, loadingFraction * 100)}%` }} />}
            </button>
          ))}
          <FileTrigger acceptedFileTypes={['.hdr']} onSelect={(files) => files && getEngine()?.loadFiles(toPathedFiles(files))}>
            <Button className="env env--upload" data-on={s.envId === 'custom' || undefined}>
              <div><Upload size={16} />{s.envId === 'custom' ? 'Custom .hdr' : 'Upload .hdr'}</div>
            </Button>
          </FileTrigger>
        </div>
        {s.envId === 'sky' && <SunTime value={s.skyTime} onChange={(v) => setSettings({ skyTime: v })} />}
        {envLoading && (
          <div className="env-loading" role="progressbar" aria-label={`Loading ${envLoading.name}`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(loadingFraction * 100)}>
            <div>
              <span>Downloading {envLoading.name}</span>
              <span className="mono">
                {formatMB(envLoading.loaded)}{envLoading.total ? ` / ${formatMB(envLoading.total)}` : ''} MB
              </span>
            </div>
            <div className="progress"><i style={{ width: `${Math.max(2, loadingFraction * 100)}%` }} /></div>
          </div>
        )}
        <Field label="Resolution">
          <Segmented
            label="HDRI resolution"
            value={s.envResolution}
            disabled={!current?.polyHaven}
            options={ENV_RESOLUTIONS.map((r) => ({ value: r.value, label: <span title={r.size}>{r.label}</span> }))}
            onChange={(v) => setSettings({ envResolution: v })}
          />
        </Field>
        <Hint>HDRIs by <a href="https://polyhaven.com/hdris" target="_blank" rel="noreferrer">Poly Haven</a> (CC0), loaded on demand.</Hint>
        {modelLighting?.available && <Hint>Scene lights stay active when you add an environment or studio lighting.</Hint>}
        <Scrub label="Intensity" value={s.envIntensity} min={0} max={4} step={0.01} onChange={(v) => setSettings({ envIntensity: v })} />
        <Scrub label="Rotation" value={s.envRotation} min={0} max={360} step={1} unit="°" onChange={(v) => setSettings({ envRotation: v })} />
      </Section>}
      {!!modelLighting?.warnings.length && <details><summary>{modelLighting.warnings.length} scene warnings</summary>{modelLighting.warnings.map((warning, i) => <Hint key={i}>{warning}</Hint>)}</details>}

      <Section title="Background" icon={<Image size={14} />}>
        <div className="bg-cards" data-count={backgrounds.length} role="radiogroup" aria-label="Background">
          {backgrounds.map(([id, label, style]) => (
            <button
              key={id}
              className="bg-card"
              role="radio"
              aria-checked={background === id}
              data-on={background === id || undefined}
              onClick={() => setSettings({ background: id })}
            >
              <i className={id === 'transparent' ? 'checker' : undefined} style={style} />{label}
            </button>
          ))}
        </div>
        {s.background === 'color' && (
          <ColorField label="Color" value={s.backgroundColor} onChange={(hex) => setSettings({ backgroundColor: hex })} />
        )}
        {background === 'grounded' && (
          <>
            <Scrub label={s.groundedHeight === null ? 'Height · auto' : 'Height'} value={grounded.height} min={0.1} max={50} step={0.05} unit="m"
              title="Height of the HDRI camera above the ground, in meters" onChange={(v) => setSettings({ groundedHeight: v })} />
            <Scrub label={s.groundedRadius === null ? 'Radius · auto' : 'Radius'} value={s.groundedRadius ?? grounded.radius} min={2} max={1000} step={1} unit="m"
              title="Radius of the projected dome, in meters; roughly the distance to the surroundings" onChange={(v) => setSettings({ groundedRadius: v })} />
            <Hint>
              Projects the HDRI onto the ground so the model stands in the scene. A real HDRI is shot about 1.6 m high;
              raise the height to shrink the model onto the clean ground near the capture point.
              {!groundedAuto && <> <button className="hint__link" onClick={() => setSettings({ groundedHeight: null, groundedRadius: null })}>Use auto</button></>}
            </Hint>
          </>
        )}
        {background === 'transparent' && <Hint>The {studio ? 'studio' : 'environment'} still lights the scene. Exported PNGs keep the alpha channel.</Hint>}
      </Section>

      <Section
        title="Ground shadow"
        icon={<Square size={14} />}
        actions={<Switch label="Ground shadow" checked={s.groundShadow} onChange={(v) => setSettings({ groundShadow: v })} />}
      >
        {s.groundShadow && (
          <>
            <Scrub label="Opacity" value={s.groundOpacity} min={0} max={1} onChange={(v) => setSettings({ groundOpacity: v })} />
            <Hint>A shadow-catcher plane under the model. Pair it with a transparent background for product shots.</Hint>
          </>
        )}
      </Section>
    </>
  );
}

const STUDIO_SWATCH = 'linear-gradient(180deg,#4a4b50 0%,#2e2f33 55%,#1c1d20 100%)';

function StudioSection() {
  const s = useViewer((state) => state.settings);
  const preset = findStudioPreset(s.studioPreset);
  return (
    <Section title="Studio" icon={<Lamp size={14} />} value={preset.name}>
      <div className="studio-grid" role="radiogroup" aria-label="Studio lighting preset">
        {STUDIO_PRESETS.map((p) => (
          <button
            key={p.id}
            className="studio-card"
            role="radio"
            aria-checked={p.id === preset.id}
            data-on={p.id === preset.id || undefined}
            title={p.tag}
            onClick={() => setSettings({ studioPreset: p.id })}
          >
            <StudioDiagram preset={p} rotation={s.studioRotation} size={s.studioSize} />
            <span><strong>{p.name}</strong><small>{p.tag}</small></span>
          </button>
        ))}
      </div>
      <Scrub label="Intensity" value={s.studioIntensity} min={0} max={4} step={0.01} onChange={(v) => setSettings({ studioIntensity: v })} />
      <Scrub label="Rotation" value={s.studioRotation} min={-180} max={180} step={1} unit="°" onChange={(v) => setSettings({ studioRotation: v })} />
      <Scrub label="Size" value={s.studioSize} min={0.25} max={3} step={0.01} unit="×"
        title="Panel size: larger panels give softer shadows and highlights at the same exposure"
        onChange={(v) => setSettings({ studioSize: v })} />
      <Scrub label="Ambient" value={s.studioAmbient} min={0} max={1} step={0.01}
        title="Fill from the studio walls and ceiling" onChange={(v) => setSettings({ studioAmbient: v })} />
      <ColorField label="Ambient color" value={s.studioAmbientColor} onChange={(hex) => setSettings({ studioAmbientColor: hex })} />
      <Hint>Softboxes placed around the model and scaled to its size; the front faces +Z, where the camera starts. The ambient fill is the studio's walls: it softens shadows and is the Studio background.</Hint>
    </Section>
  );
}

/** Lights higher than this are drawn as an overhead halo over the subject. */
const OVERHEAD_ELEVATION = 60;

/**
 * Top-down plan of a rig: the subject in the middle, the camera at the bottom
 * and each light on a ring around them, with a beam toward the subject whose
 * strength follows the light's power. Low lights sit on an outer ring so a
 * clamshell's two panels stay apart.
 */
function StudioDiagram({ preset, rotation, size }: { preset: StudioPreset; rotation: number; size: number }) {
  const id = useId();
  const side = preset.lights.filter((light) => light.elevation <= OVERHEAD_ELEVATION);
  const overhead = preset.lights.filter((light) => light.elevation > OVERHEAD_ELEVATION);
  return (
    <svg className="studio-plan" viewBox="-1.1 -0.9 2.2 2.04" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0" stopColor="#fff3dc" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff3dc" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M0 0.86 L-0.27 0.2 A0.66 0.66 0 0 1 0.27 0.2 Z" className="studio-plan__view" />
      {side.map((light, i) => {
        const azimuth = ((light.azimuth + rotation) * Math.PI) / 180;
        const radius = light.elevation < 0 ? 0.74 : 0.6;
        const length = Math.min(0.9, Math.max(0.06, light.width * size * 0.17));
        const strength = Math.min(1, light.power);
        const angle = (-azimuth * 180) / Math.PI;
        return (
          <g key={light.name} transform={`rotate(${angle.toFixed(1)})`}>
            <linearGradient id={`${id}-beam-${i}`} x1="0" y1={radius} x2="0" y2="0.12" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffe9c4" stopOpacity={0.1 + 0.32 * strength} />
              <stop offset="1" stopColor="#ffe9c4" stopOpacity="0" />
            </linearGradient>
            <path d={`M${-length / 2} ${radius} L${length / 2} ${radius} L0.1 0.1 L-0.1 0.1 Z`} fill={`url(#${id}-beam-${i})`} />
            <rect x={-length / 2} y={radius} width={length} height="0.07" rx="0.02"
              className="studio-plan__light" style={{ opacity: 0.45 + 0.55 * strength }} />
          </g>
        );
      })}
      <circle r="0.15" className="studio-plan__subject" />
      {overhead.map((light) => {
        const w = Math.min(1.2, Math.max(0.08, light.width * size * 0.14));
        const h = Math.min(1.2, Math.max(0.06, light.height * size * 0.14));
        return (
          <g key={light.name}>
            <circle r={Math.max(w, h) * 0.85 + 0.08} fill={`url(#${id}-halo)`} style={{ opacity: 0.4 + 0.6 * Math.min(1, light.power) }} />
            <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="0.04" className="studio-plan__overhead" />
          </g>
        );
      })}
      <g className="studio-plan__camera" transform="translate(0 0.95)">
        <rect x="-0.15" y="-0.03" width="0.3" height="0.17" rx="0.035" />
        <rect x="-0.075" y="-0.1" width="0.15" height="0.08" rx="0.015" />
      </g>
    </svg>
  );
}
