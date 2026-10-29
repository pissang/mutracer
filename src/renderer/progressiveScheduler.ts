export {displayAovKind as aovChannel} from './aovDisplay.js';
import type Render from '../Render.js';
import type Display from '../Display.js';
import { traceSchema } from '../settings/render.js';

// Every setting that changes the traced image, including caustics.
const imageFields = Object.values(traceSchema).filter(field => field.kind === 'image').map(field => field.key);

export interface ProgressiveState { previousChanged: boolean; lastContinuousChange: number; changing: boolean; }
/** Pure consecutive-edit policy; isolated changes start final immediately. */
export function updateProgressiveState(state: ProgressiveState, changed: boolean, active: boolean, now: number, idleMs: number): ProgressiveState {
  const lastContinuousChange = active ? -Infinity : changed && state.previousChanged ? now : state.lastContinuousChange;
  return {previousChanged: changed && !active, lastContinuousChange, changing: active || now - lastContinuousChange < Math.max(0, idleMs)};
}

/** Public state used to leave a finished canvas idle while still noticing settings edits. */
export function loopImageState(render: Render, display: Display): string {
  return JSON.stringify([
    render.samples, render.width, render.height, render.maxSamples, imageFields.map(key => render[key]),
    render.resolutionScale, render.adaptiveResolution, render.denoiser, render.denoising,
    render.aovs, render.aovSamples,
    display.canvas.width, display.canvas.height, display.toneMapping, display.toneMappingExposure,
    display.contrast, display.saturation, display.temperature, display.tint, display.vignette,
    display.bloomIntensity, display.bloomThreshold, display.bloomRadius, display.hdrOutputEnabled,
    display.channel, display.shadowCatcherColor, display.shadowCatcherAlpha,
    display.aovDepthRange, display.aovPositionScale, display.aovMotionScale, display.aovIdComponent,
  ]);
}
