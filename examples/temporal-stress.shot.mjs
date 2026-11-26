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

let shot;

export function setup({mutracer}) {
  shot = createTemporalStressShot(mutracer);
  return {scene: shot.scene, camera: shot.camera};
}

export function frame({t}) {
  shot.setTime(t);
}
