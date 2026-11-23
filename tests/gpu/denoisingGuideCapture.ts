import {Camera, Engine, EnvironmentLight, Mesh, OpenPBRMaterial, Render, Texture, createPlaneGeometry} from '../../src/main.js';
import type {DenoisingGuideCapture} from '../../src/renderer/denoisingGuideCapture.js';

const width = 16, height = 16, samples = 4;
const backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';

async function capture(mode?: DenoisingGuideCapture) {
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  if (mode) engine._captureDenoisingGuides(mode);
  const render = new Render(engine, {width, height, bounces: 3, bevel: false, maxTiles: 1, samplingPattern: 'sobol'});
  try {
    const info = await engine.init();
    const plane = createPlaneGeometry(4, 4, 'vertical');
    const mirror = new Mesh(plane, new OpenPBRMaterial({
      baseColor: [.7, .35, .15], baseMetalness: 1, specularRoughness: .01,
    }));
    const wall = new Mesh(plane, new OpenPBRMaterial({baseColor: [.15, .6, .3], specularWeight: 0}));
    wall.position = [0, 0, 4];
    const camera = new Camera({
      projection: 'orthographic', left: -.1, right: .1, bottom: -.1, top: .1, near: .1, far: 12,
    });
    camera.position = [0, 0, 2];
    camera.lookAt([0, 0, 0]);
    engine.camera = camera;
    const white = new Texture({width: 8, height: 4, data: new Float32Array(8 * 4 * 4).fill(1)});
    engine.scene = {meshes: [mirror, wall], lights: [new EnvironmentLight({map: white})]};
    engine.update();
    await render.converge({samples, sampleSequenceOffset: 13, timeoutMs: 120_000});
    if (engine.lastError) throw engine.lastError;
    const read = async (kind: 'hdr' | 'albedo' | 'normal') => {
      const {data} = await render.readPixels(kind);
      if (data.length !== width * height * 4 || !data.every(Number.isFinite)) throw new Error(`Invalid ${kind} capture`);
      return data;
    };
    return {adapter: info.adapterName, hdr: await read('hdr'), albedo: await read('albedo'), normal: await read('normal')};
  } finally {
    render.dispose();
    engine.dispose();
  }
}

async function run() {
  const baseline = await capture();
  const first = await capture('surface');
  const follow = await capture('path');
  const depth = await capture('depth');
  for (const variant of [first, follow, depth]) {
    if (!variant.hdr.every((value, index) => Object.is(value, baseline.hdr[index]))) {
      throw new Error('Capturing a secondary path changed fixed-seed HDR');
    }
  }
  const expected = [.105, .21, .045];
  let maxDepthError = 0;
  for (let i = 0; i < first.hdr.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(first.albedo[i + c]) > 1e-5 || Math.abs(follow.albedo[i + c] - expected[c]) > .001) {
        throw new Error(`Pixel ${i / 4} did not defer the mirror reflectance to the wall`);
      }
    }
    // Segment lengths start at the near plane and at the reflected ray's origin.
    const error = Math.abs(depth.albedo[i + 1] - (1.9 + 4 * depth.albedo[i]));
    if (depth.albedo[i + 2] !== 2 || Math.abs(depth.albedo[i] - .4) > .001 || error > .004) {
      throw new Error(`Pixel ${i / 4} had an unexpected pair of reflected depth contributions`);
    }
    if (first.normal[i + 2] < .99 || Math.abs(follow.normal[i + 2] - .3) > .01) {
      throw new Error(`Pixel ${i / 4} did not use the weighted normal of the wall`);
    }
    maxDepthError = Math.max(maxDepthError, error);
  }
  return {backend, adapter: baseline.adapter, pixels: width * height, maxDepthError, passed: true};
}

const completion = run();
Object.assign(window, {denoisingGuideCaptureResult: completion});
completion.then(result => {
  document.querySelector('#result')!.textContent = JSON.stringify(result);
}, error => {
  document.querySelector('#result')!.textContent = String(error?.stack ?? error);
});
