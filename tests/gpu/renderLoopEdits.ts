import {Camera, Engine, Mesh, OpenPBRMaterial, RenderLoop, SphereLight, SpotLight, Texture, createPlaneGeometry, createSphereGeometry} from '../../src/main.js';

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Every edit must reach a finished image on a real GPU, alone, in random sequences
 * and during convergence. Reports each failure instead of stopping at the first.
 */
export async function run(backend: 'webgpu' | 'webgl' = 'webgpu', textureBinding: 'atlas' | 'auto' = 'atlas', timeoutMs = 40000) {
  const canvas = document.createElement('canvas');
  canvas.width = 192; canvas.height = 144;
  const engine = new Engine({canvas, backend, textureBinding});
  const errors = new Set<string>(), gpuErrors = new Set<string>();
  engine.on('error', error => errors.add(error.message));
  const camera = new Camera({projection: 'perspective', aspect: 4 / 3, fov: 50});
  camera.position = [3, 2.6, 4]; camera.lookAt([0, 0, 0]);
  engine.camera = camera;
  const glass = () => {
    const mesh = new Mesh(createSphereGeometry(16, 8), new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0}));
    mesh.position = [0, .85, 0];
    return mesh;
  };
  const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [.6, .6, .6]}));
  floor.transform[0] = floor.transform[10] = 6;
  const material = floor.materials[0];
  const spot = new SpotLight({intensity: 120, radius: 0, innerAngle: 25, outerAngle: 35});
  spot.position = [-1.5, 3, 0]; spot.lookAt([0, 0, 0]);
  const scene: NonNullable<Engine['scene']> = engine.scene = {meshes: [floor, glass()], lights: [spot], background: [0, 0, 0, 1]};
  await engine.init();
  engine.device?.addEventListener('uncapturederror', event => gpuErrors.add((event as GPUUncapturedErrorEvent).error.message));
  const loop = new RenderLoop(engine, {final: {maxSamples: 4, bounces: 6}});
  const final = loop.final, preview = loop.preview!;
  const texture = (value: number) => new Texture({width: 2, height: 2, data: new Uint8Array(16).fill(value)});
  const setAov = (enabled: boolean) => {
    final.aovs = preview.aovs = enabled ? ['depth'] : [];
    engine.display.channel = enabled ? 'depth' : 'final';
  };
  const edits: Record<string, () => void> = {
    pattern: () => { final.samplingPattern = final.samplingPattern === 'sobol' ? 'random' : 'sobol'; },
    bevel: () => { final.bevelSamples = final.bevelSamples % 32 + 3; },
    bounces: () => { final.bounces = final.bounces % 8 + 1; },
    scale: () => { final.resolutionScale = final.resolutionScale === 1 ? .5 : 1; },
    resize: () => { engine.display.setSize(canvas.width === 192 ? 256 : 192, 144); },
    camera: () => { camera.position = [camera.position[0] + .1, 2.6, 4]; camera.lookAt([0, 0, 0]); },
    addMesh: () => { scene.meshes = [...scene.meshes, glass()]; },
    removeMesh: () => { if (scene.meshes.length > 2) scene.meshes = scene.meshes.slice(0, -1); },
    replaceMeshes: () => { scene.meshes = [floor, glass(), glass()]; },
    color: () => { material.baseColor = [Math.random(), .5, .5]; },
    coat: () => { material.coatWeight = material.coatWeight ? 0 : 1; },
    texture: () => { material.map = texture(100 + Math.floor(Math.random() * 100)); },
    noTexture: () => { material.map = undefined; },
    addLight: () => { const light = new SphereLight({intensity: 5, radius: .1}); light.position = [1, 2, 1]; scene.lights = [...scene.lights, light]; },
    removeLight: () => { scene.lights = scene.lights.slice(0, 1); },
    background: () => { scene.background = [Math.random(), 0, 0, 1]; },
    exposure: () => { engine.display.toneMappingExposure = 1 + Math.random(); },
    aov: () => setAov(true),
    noAov: () => setAov(false),
    denoiser: () => { void final.setDenoiser({type: 'jnlm', schedule: 'every-sample'}); },
    noDenoiser: () => { void final.setDenoiser(null); },
    ...(backend === 'webgpu' ? {
      lightTracing: () => { final.caustics = {lightTracing: true}; },
      photonMapping: () => { final.caustics = {photonMapping: true}; },
      noCaustics: () => { final.caustics = undefined; },
      alpha: () => { material.opacity = material.opacity < 1 ? 1 : .5; material.alphaMode = material.opacity < 1 ? 'blend' : 'opaque'; }
    } : {})
  };
  const finish = async () => {
    const start = performance.now();
    for (;;) {
      const status = loop.tick();
      await sleep(4);
      if ((status === 'finished' || status === 'error') && !final.denoising) return {status, ms: Math.round(performance.now() - start)};
      if (performance.now() - start > timeoutMs) return {status: `timeout in ${status}`, ms: timeoutMs, samples: final.samples};
    }
  };
  const failures: unknown[] = [];
  const settled = async (name: string) => {
    const result = await finish();
    if (result.status !== 'finished') failures.push({name, ...result});
    return result.ms;
  };
  await settled('initial');
  const slowest = {name: '', ms: 0};
  for (const [name, edit] of Object.entries(edits)) {
    edit();
    const ms = await settled(name);
    if (ms > slowest.ms) Object.assign(slowest, {name, ms});
  }
  const names = Object.keys(edits);
  let seed = 7;
  const pick = (limit: number) => { seed = seed * 1664525 + 1013904223 >>> 0; return (seed >>> 8) % limit; };
  for (let round = 0; round < 3; round++) {
    for (let step = 0; step < 60; step++) {
      const action = pick(3);
      if (action === 0) edits[names[pick(names.length)]]();
      if (action < 2) loop.tick();
      await sleep(pick(3) * 8);
    }
    edits.noAov();
    await settled(`random ${round}`);
  }
  const convergence = {resolved: 0, rejected: 0};
  const convergenceEdits = ['pattern', 'bounces', 'camera', 'addMesh', 'coat', ...(backend === 'webgpu' ? ['lightTracing'] : [])];
  for (let run = 0; run < 14; run++) {
    const task = loop.converge({samples: 32, samplesPerBatch: 4}).then(() => 'resolved', () => 'rejected');
    if (run % 2) {
      await sleep(run * 3);
      edits[convergenceEdits[run % convergenceEdits.length]]();
      engine.update();
    }
    const outcome = await Promise.race([task, sleep(60000).then(() => 'hung')]);
    if (outcome === 'hung') failures.push({name: `convergence ${run}`, status: outcome});
    else convergence[outcome as 'resolved' | 'rejected']++;
    await settled(`after convergence ${run}`);
  }
  const textures = engine.getDiagnostics()?.materialTextures?.active;
  loop.dispose(); engine.dispose();
  return {
    passed: !failures.length && !errors.size && !gpuErrors.size,
    backend, textures, slowest, convergence, failures,
    errors: [...errors], gpuErrors: [...gpuErrors]
  };
}

(globalThis as typeof globalThis & {renderLoopEditTests?: unknown}).renderLoopEditTests = {run};
