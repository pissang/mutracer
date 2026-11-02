// Real-GPU regression fixture; run fog.html (?webgl for WebGL 2).
import {Engine, Render, Camera, AmbientLight, SphereLight, Mesh, OpenPBRMaterial,
  createCubeGeometry, createPlaneGeometry, createSphereGeometry, type Scene, type SceneFog} from '../../src/main.js';

export async function captureFogCombination(backend: 'webgpu' | 'webgl', name: string, withoutFog = false) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend}); engine.display.setSize(24, 24);
  const camera = new Camera({projection: 'orthographic', left: -.5, right: .5, top: .5, bottom: -.5, near: .1, far: 100});
  camera.position = [0, 0, 3]; camera.lookAt([0, 0, 0]); engine.camera = camera;
  const fog: SceneFog = {density: .4, bounds: {min: [-1, -1, -1], max: [1, 1, 1]}, color: [0, 0, 0]};
  const scene: Scene = {meshes: [], lights: [new AmbientLight({intensity: .5})], fog: [fog]};
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
  if (name === 'catcher') { sheet(new OpenPBRMaterial({shadowCatcher: true})); fog.color = [1, 1, 1]; }
  if (name === 'transparent') { scene.background = [0, 0, 0, 0]; fog.color = [1, 1, 1]; }
  if (name === 'display-background') {
    scene.lights = []; scene.background = [.5, .5, .5, 1]; fog.color = [1, 1, 1]; fog.anisotropy = .8;
  }
  if (withoutFog) scene.fog = [];
  engine.scene = scene; engine.update();
  const render = new Render(engine, {width: 24, height: 24, bounces: 20, maxSamples: 2048,
    bevel: name === 'bevel', clamping: 0, samplingPattern: 'sobol', alphaBlendStrategy: name === 'alpha-stochastic' ? 'stochastic' : 'deterministic-source-over', caustics: {lightTracing: true, photonMapping: true}});
  const errors: string[] = []; engine.on('error', event => errors.push(event.message));
  try {
    const info = await engine.init(); engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 2048, sampleSequenceOffset: 17, timeoutMs: 120000});
    const hdr = await render.readPixels('hdr'), albedo = await render.readPixels('albedo'), normal = await render.readPixels('normal');
    if ([hdr, albedo, normal].some(image => image.data.some((value: number) => !Number.isFinite(value)))) throw new Error('Nonfinite fog output');
    return {name, info, errors, pixels: Array.from(hdr.data), albedo: Array.from(albedo.data), normal: Array.from(normal.data), diagnostics: engine.getDiagnostics()};
  } finally {render.dispose(); engine.dispose(); canvas.remove();}
}
(window as any).captureFogCombination = captureFogCombination;

/** Camera-visible analytic lights must not change the camera segment. */
export async function captureFogInvariant(backend: 'webgpu' | 'webgl', name: string, control = false) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend}); engine.display.setSize(24, 24);
  const camera = new Camera({projection: 'orthographic', left: -.75, right: .75, top: .75, bottom: -.75, near: .1, far: 100});
  camera.position = [0, 0, 5]; camera.lookAt([0, 0, 0]); engine.camera = camera;
  const fog: SceneFog = {density: .5, bounds: {min: [100, 100, 100], max: [101, 101, 101]}};
  const scene: Scene = {meshes: [], lights: [], background: [.5, .5, .5, 1], fog: control ? [] : [fog]};
  const sheet = (material: OpenPBRMaterial, z: number) => {
    const mesh = new Mesh(createPlaneGeometry(), material);
    mesh.transform = [4, 0, 0, 0, 0, 0, 4, 0, 0, -4, 0, 0, 0, 0, z, 1];
    scene.meshes.push(mesh);
  };
  scene.lights.push(new SphereLight({radius: .5}));
  if (name === 'analytic-alpha') sheet(new OpenPBRMaterial({unlit: true,
    emissionColor: [.1, .1, .1], emissionLuminance: 1, alphaMode: 'blend', opacity: .35}), 2);
  if (name === 'analytic-in-fog') {
    fog.bounds = {min: [-2, -2, -2], max: [2, 2, 2]}; fog.color = [0, 0, 0];
    scene.fog = [fog]; if (control) scene.lights = [];
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
  engine.scene = scene; engine.update();
  const render = new Render(engine, {width: 24, height: 24, bounces: 2, maxSamples: 2048, clamping: 0,
    samplingPattern: 'sobol', alphaBlendStrategy: 'deterministic-source-over'});
  const errors: string[] = []; engine.on('error', event => errors.push(event.message));
  try {
    await engine.init(); engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 2048, sampleSequenceOffset: 17, timeoutMs: 120000});
    const images = await Promise.all(['hdr', 'albedo', 'normal'].map(kind => render.readPixels(kind as 'hdr')));
    if (images.some(image => image.data.some((value: number) => !Number.isFinite(value)))) throw new Error('Nonfinite fog output');
    if (errors.length) throw new Error(errors.join('\n'));
    return {name, errors, pixels: Array.from(images[0].data), albedo: Array.from(images[1].data), normal: Array.from(images[2].data)};
  } finally {render.dispose(); engine.dispose(); canvas.remove();}
}

/** Run in the console on fog.html; rejects on a real GPU regression. */
export async function checkFogInvariants(backend: 'webgpu' | 'webgl', names = ['analytic-primary', 'analytic-alpha', 'analytic-in-fog', 'glass-pair', 'glass-single']) {
  const results = [];
  for (const name of names) {
    const actual = await captureFogInvariant(backend, name), expected = await captureFogInvariant(backend, name, true);
    const differences = Object.fromEntries((['pixels'] as const).map(kind => [kind,
      Math.max(...actual[kind].map((value, i) => Math.abs(value - expected[kind][i])))]));
    if (Object.values(differences).some(value => value > .00025)) throw new Error(`${backend} ${name}: ${JSON.stringify(differences)}`);
    results.push({name, differences});
  }
  return results;
}
Object.assign(window, {captureFogInvariant, checkFogInvariants});
