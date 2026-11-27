// The temporal stress example as a shot module for the Node CLI frontend:
//   node cli/dist/main.mjs render examples/temporal-stress.shot.mjs -o stress.mp4
// Loading the TypeScript scene module needs Node 22.18 or newer (type stripping).
import {createTemporalStressShot, temporalStressTiming} from './shared/temporalStressShot.ts';

export const output = {
  duration: temporalStressTiming.duration,
  fps: temporalStressTiming.fps,
  size: [1280, 720],
  spp: 3,
  render: {bounces: 6},
  denoise: 'temporal',
  sampleSequence: 'frame',
  temporal: {mode: 'offline'}
};

// The center-ray pilot replays this absolute camera cut before allocating tiles.
export const experimentalGeometryCuts = [Math.ceil(temporalStressTiming.cut * temporalStressTiming.fps)];

// Regions whose authored radiance changes can overlap scan candidates.
export const artifactEvents = [
  {label: 'Candle flame animation', first: 0, last: 239, objects: ['flame']},
  {label: 'LED hue animation', first: 0, last: 239, objects: ['led']},
  ...Array.from({length: 7}, (_, i) => ({
    label: 'Screen slide change', first: 30 * (i + 1), last: 30 * (i + 1) + 1,
    objects: ['screen'],
  })),
  {label: 'Lamp dims', first: 168, last: 178, objects: ['lamp shade']},
  {label: 'Lamp brightens', first: 216, last: 226, objects: ['lamp shade']},
  {label: 'Vase glaze change', first: 156, last: 157, objects: ['vase']},
  {label: 'Bowl roughness ramp', first: 140, last: 197, objects: ['bowl']},
];

let shot;

export function setup({mutracer}) {
  shot = createTemporalStressShot(mutracer);
  return {scene: shot.scene, camera: shot.camera};
}

export function frame({t}) {
  shot.setTime(t);
}
