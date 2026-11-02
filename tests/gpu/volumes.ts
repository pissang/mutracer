// Real-GPU regression fixture; run volumes.html (?webgl for WebGL 2).
import {Engine, Render, Camera, AmbientLight, SphereLight, Mesh, OpenPBRMaterial,
  createCubeGeometry, createPlaneGeometry, createSphereGeometry, type Scene, type SceneVolume} from '../../src/main.js';

export async function captureVolumeCombination(backend: 'webgpu' | 'webgl', name: string, withoutVolume = false) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend}); engine.display.setSize(24, 24);
  const camera = new Camera({projection: 'orthographic', left: -.5, right: .5, top: .5, bottom: -.5, near: .1, far: 100});
  camera.position = [0, 0, 3]; camera.lookAt([0, 0, 0]); engine.camera = camera;
  const volumes: SceneVolume = {density: .4, bounds: {min: [-1, -1, -1], max: [1, 1, 1]}, color: [0, 0, 0]};
  const scene: Scene = {meshes: [], lights: [new AmbientLight({intensity: .5})], volumes: [volumes]};
  const sheet = (material: OpenPBRMaterial, z = 0) => {
    const mesh = new Mesh(createPlaneGeometry(), material);
    mesh.transform = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, z, 1];
    scene.meshes.push(mesh);
  };
  if (name === 'glass' || name === 'sss' || name === 'bevel') {
    const material = new OpenPBRMaterial(name === 'glass'
      ? {transmissionWeight: 1, specularIor: 1, specularRoughness: 0}
      : name === 'bevel' ? {bevelSize: .05, baseColor: [.8, .7, .6]}
      : {subsurfaceWeight: 1, subsurfaceRadius: .4, subsurfaceRadiusScale: [1, 1, 1], baseColor: [.8, .7, .6]});
    const box = new Mesh(createCubeGeometry(), material);
    box.transform[0] = box.transform[5] = box.transform[10] = 1; scene.meshes.push(box);
  }
  if (name === 'thin') sheet(new OpenPBRMaterial({transmissionWeight: 1, specularIor: 1, specularRoughness: 0, thinWalled: true}));
  if (name === 'alpha' || name === 'alpha-stochastic' || name === 'unlit') {
    sheet(new OpenPBRMaterial({unlit: true, emissionColor: [.6, .2, .1], emissionLuminance: 1,
      alphaMode: 'blend', opacity: name.startsWith('alpha') ? .35 : 1}));
    scene.lights = []; scene.background = [.5, .5, .5, 1];
  }
  if (name === 'alpha-null') {
    sheet(new OpenPBRMaterial({alphaMode: 'blend', opacity: 0}), .5);
    sheet(new OpenPBRMaterial({alphaMode: 'blend', opacity: 0}), 0);
    sheet(new OpenPBRMaterial({alphaMode: 'blend', opacity: 0}), -.5);
  }
  if (name === 'catcher') { sheet(new OpenPBRMaterial({shadowCatcher: true})); volumes.color = [1, 1, 1]; }
  if (name === 'transparent') { scene.background = [0, 0, 0, 0]; volumes.color = [1, 1, 1]; }
  if (name === 'display-background') {
    scene.lights = []; scene.background = [.5, .5, .5, 1]; volumes.color = [1, 1, 1]; volumes.anisotropy = .8;
  }
  if (withoutVolume) scene.volumes = [];
  if (name === 'glass-alpha-budget') {
    scene.lights = [new AmbientLight({intensity: .5})];
    const glass = new OpenPBRMaterial({transmissionWeight: 1, specularIor: 1, specularRoughness: 0});
    for (let i = 0; i < 10; i++) {
      const sphere = new Mesh(createSphereGeometry(16, 8), glass); sphere.position = [0, 0, 3 - i * 2.5];
      scene.meshes.push(sphere);
    }
    sheet(new OpenPBRMaterial({transmissionWeight: 1, specularIor: 1, specularRoughness: 0,
      thinWalled: true, alphaMode: 'blend', opacity: .35}), 4.5);
  }
  engine.scene = scene; engine.update();
  const render = new Render(engine, {width: 24, height: 24, bounces: name === 'glass-alpha-budget' ? 7 : 20, maxSamples: 2048,
    bevel: name === 'bevel', clamping: 0, samplingPattern: 'sobol', alphaBlendStrategy: name === 'alpha-stochastic' ? 'stochastic' : 'deterministic-source-over', caustics: {lightTracing: true, photonMapping: true}});
  const errors: string[] = []; engine.on('error', event => errors.push(event.message));
  try {
    const info = await engine.init(); engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 2048, sampleSequenceOffset: 17, timeoutMs: 120000});
    const hdr = await render.readPixels('hdr'), albedo = await render.readPixels('albedo'), normal = await render.readPixels('normal');
    if ([hdr, albedo, normal].some(image => image.data.some((value: number) => !Number.isFinite(value)))) throw new Error('Nonfinite volumes output');
    return {name, info, errors, pixels: Array.from(hdr.data), albedo: Array.from(albedo.data), normal: Array.from(normal.data), diagnostics: engine.getDiagnostics()};
  } finally {render.dispose(); engine.dispose(); canvas.remove();}
}
(window as any).captureVolumeCombination = captureVolumeCombination;

/** Compare volumes transport and guides against the ordinary surface integrator. */
export async function captureVolumeInvariant(backend: 'webgpu' | 'webgl', name: string, control = false) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend}); engine.display.setSize(24, 24);
  const camera = new Camera({projection: 'orthographic', left: -.75, right: .75, top: .75, bottom: -.75, near: .1, far: 100});
  camera.position = [0, 0, 5]; camera.lookAt([0, 0, 0]); engine.camera = camera;
  const volumes: SceneVolume = {density: .5, bounds: {min: [100, 100, 100], max: [101, 101, 101]}};
  if (name.endsWith('-noise')) { volumes.noise = {size: [1, 2, 3]}; volumes.edgeFade = .3; name = name.slice(0, -6); }
  const scene: Scene = {meshes: [], lights: [], background: [.5, .5, .5, 1], volumes: control ? [] : [volumes]};
  const sheet = (material: OpenPBRMaterial, z: number) => {
    const mesh = new Mesh(createPlaneGeometry(), material);
    mesh.transform = [4, 0, 0, 0, 0, 0, 4, 0, 0, -4, 0, 0, 0, 0, z, 1];
    scene.meshes.push(mesh);
  };
  scene.lights.push(new SphereLight({radius: .5}));
  if (name === 'analytic-alpha' || name === 'analytic-alpha-in-volumes') sheet(new OpenPBRMaterial({unlit: true,
    emissionColor: [.1, .1, .1], emissionLuminance: 1, alphaMode: 'blend', opacity: .35}), 2);
  if (name === 'analytic-in-volumes' || name === 'analytic-alpha-in-volumes') {
    volumes.bounds = {min: [-2, -2, -2], max: [2, 2, 2]}; volumes.color = [0, 0, 0];
    scene.volumes = [volumes]; if (control) scene.lights = [];
    sheet(new OpenPBRMaterial({unlit: true, emissionColor: [.5, .5, .5], emissionLuminance: 1}), -3);
  }
  if (name === 'glass-pair' || name === 'glass-single') {
    scene.lights = [new AmbientLight({intensity: .5})];
    for (const z of name === 'glass-pair' ? [1.5, -1.5] : [0]) {
      const sphere = new Mesh(createSphereGeometry(64, 32), new OpenPBRMaterial({transmissionWeight: 1,
        specularRoughness: 0, specularIor: name === 'glass-pair' ? 1.02 : 1.5}));
      sphere.position = [0, 0, z]; scene.meshes.push(sphere);
    }
  }
  if (name.startsWith('mirror')) {
    scene.lights = [new AmbientLight({intensity: .5})];
    scene.meshes.push(new Mesh(createSphereGeometry(64, 32), new OpenPBRMaterial({baseMetalness: 1, specularRoughness: 0})));
    sheet(new OpenPBRMaterial({baseColor: [.1, .8, .1], doubleSided: true}), 6);
    if (name.includes('alpha')) sheet(new OpenPBRMaterial({baseColor: [.8, .3, .1],
      alphaMode: 'blend', opacity: .35, specularWeight: 0}), 2);
    if (name.includes('spectral')) {
      const glass = new Mesh(createSphereGeometry(8, 4), new OpenPBRMaterial({transmissionWeight: 1, transmissionDispersionScale: 1}));
      glass.position = [10, 0, 0]; scene.meshes.push(glass);
    }
    if (name.endsWith('-volumes')) {
      volumes.bounds = {min: [-2, -2, 3], max: [2, 2, 4]}; volumes.color = [.2, .4, .6];
    }
  }
  if (name === 'glass-alpha-budget') {
    scene.lights = [new AmbientLight({intensity: .5})];
    const glass = new OpenPBRMaterial({transmissionWeight: 1, specularIor: 1, specularRoughness: 0});
    for (let i = 0; i < 10; i++) {
      const sphere = new Mesh(createSphereGeometry(16, 8), glass); sphere.position = [0, 0, 3 - i * 2.5];
      scene.meshes.push(sphere);
    }
    sheet(new OpenPBRMaterial({transmissionWeight: 1, specularIor: 1, specularRoughness: 0,
      thinWalled: true, alphaMode: 'blend', opacity: .35}), 4.5);
  }
  engine.scene = scene; engine.update();
  const render = new Render(engine, {width: 24, height: 24, bounces: name === 'glass-alpha-budget' ? 7 : 2, maxSamples: 2048, clamping: 0,
    samplingPattern: 'sobol', alphaBlendStrategy: 'deterministic-source-over'});
  const errors: string[] = []; engine.on('error', event => errors.push(event.message));
  try {
    await engine.init(); engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 2048, sampleSequenceOffset: 17, timeoutMs: 120000});
    const images = await Promise.all((['hdr', 'albedo', 'normal'] as const).map(kind => render.readPixels(kind)));
    if (images.some(image => image.data.some((value: number) => !Number.isFinite(value)))) throw new Error('Nonfinite volumes output');
    if (errors.length) throw new Error(errors.join('\n'));
    return {name, errors, pixels: Array.from(images[0].data), albedo: Array.from(images[1].data), normal: Array.from(images[2].data)};
  } finally {render.dispose(); engine.dispose(); canvas.remove();}
}

/** Run in the console on volumes.html; rejects on a real GPU regression. */
export async function checkVolumeInvariants(backend: 'webgpu' | 'webgl', names = [
  'analytic-primary', 'analytic-primary-noise', 'glass-single-noise', 'mirror-noise', 'analytic-alpha', 'analytic-in-volumes', 'analytic-alpha-in-volumes', 'glass-pair', 'glass-single', 'glass-alpha-budget',
  'mirror', 'mirror-alpha', 'mirror-spectral', 'mirror-volumes', 'mirror-alpha-volumes', 'mirror-spectral-volumes'
]) {
  const results = [];
  for (const name of names) {
    const actual = await captureVolumeInvariant(backend, name), expected = await captureVolumeInvariant(backend, name, true);
    const tr = name.startsWith('mirror') && name.endsWith('-volumes') ? Math.exp(-.5) : 1;
    const differences = {pixels: 0, albedo: 0, normal: 0};
    for (let i = 0; i < actual.pixels.length; i++) {
      const channel = i % 4;
      if (tr === 1) differences.pixels = Math.max(differences.pixels, Math.abs(actual.pixels[i] - expected.pixels[i]));
      if (channel === 3) continue;
      const volumeAlbedo = [.2, .4, .6][channel];
      differences.albedo = Math.max(differences.albedo, Math.abs(actual.albedo[i] - (tr * expected.albedo[i] + (1 - tr) * volumeAlbedo)));
      const pixel = i - channel;
      const normal = actual.normal[pixel + 3] ? actual.normal[i] * 2 - 1 : 0;
      let baseNormal = expected.normal[pixel + 3] ? expected.normal[i] * 2 - 1 : 0;
      const squaredLength = [0, 1, 2].reduce((sum, c) => sum + (expected.normal[pixel + 3] ? (expected.normal[pixel + c] * 2 - 1) ** 2 : 0), 0);
      // readPixels clears short normals in the normalized public output.
      if (backend === 'webgl' && tr < 1 && !actual.normal[pixel + 3] && squaredLength * tr * tr <= .105) baseNormal = 0;
      differences.normal = Math.max(differences.normal, Math.abs(normal - tr * baseNormal));
    }
    // Public guides are quantized to eight bits; account for both captures.
    if (differences.pixels > .00025 || differences.albedo > 1.01 / 255 || differences.normal > 4.01 / 255) {
      throw new Error(`${backend} ${name}: ${JSON.stringify(differences)}`);
    }
    results.push({name, differences});
  }
  return results;
}
Object.assign(window, {captureVolumeInvariant, checkVolumeInvariants});

import {checkVolumeNoiseValues} from './volumeNoise';
Object.assign(window, {checkVolumeNoiseValues});

import {noiseMask} from '../fixtures/volumeNoiseReference';

/** Absorption across a fading box/ellipsoid boundary against numerical quadrature. */
export async function captureVolumeBoundary(backend: 'webgpu' | 'webgl', shape: string) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend}); engine.display.setSize(256, 1);
  const camera = new Camera({projection: 'orthographic', left: -1.2, right: 1.2, top: .0001, bottom: -.0001, near: .1, far: 100});
  camera.position = [0, 0, 3]; camera.lookAt([0, 0, 0]); engine.camera = camera;
  const volume: SceneVolume = {density: .8, bounds: {min: [-1, -1, -1], max: [1, 1, 1]},
    shape: shape === 'ellipsoid' ? 'ellipsoid' : 'box', color: [0, 0, 0], edgeFade: .4};
  if (shape === 'box-noise') volume.noise = {size: [1.3, 1.7, 1.1], offset: [.37, .19, -.23], coverage: .6, softness: .4};
  engine.scene = {meshes: [], lights: [], background: [.5, .5, .5, 1], volumes: [volume]}; engine.update();
  const render = new Render(engine, {width: 256, height: 1, bounces: 2, maxSamples: 8192, samplingPattern: 'sobol', clamping: 0});
  const errors: string[] = []; engine.on('error', event => errors.push(event.message));
  try {
    await engine.init(); engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 8192, sampleSequenceOffset: 17, timeoutMs: 120000});
    const hdr = await render.readPixels('hdr'), expected: number[] = [];
    for (let pixel = 0; pixel < 256; pixel++) {
      const x = -1.2 + 2.4 * (pixel + .5) / 256;
      let tau = 0;
      for (let step = 0; step < 2048; step++) {
        const z = -1 + 2 * (step + .5) / 2048;
        const edge = 1 - (volume.shape === 'ellipsoid' ? Math.hypot(x, z) : Math.max(Math.abs(x), Math.abs(z)));
        const t = Math.max(0, Math.min(1, edge / .4));
        const noise = volume.noise ? noiseMask([x, 0, z], [1.3, 1.7, 1.1], [.37, .19, -.23], .6, .4) : 1;
        tau += .8 * t * t * (3 - 2 * t) * noise * 2 / 2048;
      }
      expected.push(.5 * Math.exp(-tau));
    }
    const error = expected.map((v, i) => hdr.data[i * 4] - v);
    const rmse = Math.sqrt(error.reduce((sum, e) => sum + e * e, 0) / 256);
    if (rmse > .006 || errors.length) throw new Error(`Volume boundary ${shape}: ${rmse}; ${errors}`);
    return {shape, rmse, maxError: Math.max(...error.map(Math.abs)), expected, pixels: Array.from(hdr.data), errors};
  } finally { render.dispose(); engine.dispose(); canvas.remove(); }
}
Object.assign(window, {captureVolumeBoundary});
