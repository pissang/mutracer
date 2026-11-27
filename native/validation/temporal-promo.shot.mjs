// Native version of the promotional dining-room orbit.
import {createTemporalStressShot} from '../../examples/shared/temporalStressShot.ts';

export const output = {
  duration: 400 / 24,
  fps: 24,
  size: [1280, 720],
  spp: 3,
  render: {bounces: 6},
  seed: 'fixed',
  seedValue: 12345,
  denoise: 'temporal',
  sampleSequence: 'frame',
  temporal: {mode: 'offline', reflectionMotion: true, historyInvalidation: 'auto'},
};

export const artifactEvents = [
  {label: 'Candle flame animation', first: 0, last: 399, objects: ['flame']},
  {label: 'LED hue animation', first: 0, last: 399, objects: ['led']},
  ...Array.from({length: 13}, (_, i) => ({
    label: 'Screen slide change', first: 30 * (i + 1), last: 30 * (i + 1) + 1,
    objects: ['screen'],
  })),
];

let shot, lamp, shade, vase, bowl;

export function setup({mutracer}) {
  shot = createTemporalStressShot(mutracer);
  const material = name => shot.scene.meshes.find(mesh => mesh.name === name).materials[0];
  lamp = shot.scene.lights[2];
  shade = material('lamp shade');
  vase = material('vase');
  bowl = material('bowl');
  return {scene: shot.scene, camera: shot.camera};
}

function easeTime(u) {
  const e = .1;
  const k = 1 / (2 * e * (1 - e));
  u = Math.min(Math.max(u, 0), 1);
  if (u < e) return u * u * k;
  if (u > 1 - e) return 1 - (1 - u) ** 2 * k;
  return (u - e / 2) / (1 - e);
}

export function frame({t}) {
  shot.setTime(t, {depthOfField: false});
  lamp.intensity = 50;
  shade.emissionLuminance = 2.5;
  vase.baseColor = [.05, .35, .4];
  bowl.specularRoughness = .05;
  const u = easeTime(t / 16.6);
  const a = (100 - 200 * u) * Math.PI / 180;
  const g = a + Math.PI;
  const r = 1 - .3 * Math.sin(Math.PI * u) ** 2;
  shot.camera.position = [.3 + r * 2.1 * Math.sin(a), 1.45 - .3 * (1 - r), -.35 + r * 1.65 * Math.cos(a)];
  shot.camera.lookAt([.3 + 1.3 * Math.sin(g), 1.05, -.35 + 1.3 * Math.cos(g)]);
  shot.camera.fov = 50;
  shot.camera.fStop = 0;
}
