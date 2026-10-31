import {afterEach, describe, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine';
import RenderLoop from '../../src/RenderLoop';
import Render from '../../src/Render';
import Camera from '../../src/scene/Camera';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {SpotLight, SphereLight} from '../../src/main';
import {createPlaneGeometry, createSphereGeometry} from '../../src/main';
import {installFakeGPU} from '../helpers/fakeGPU';

const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));
let active: ReturnType<typeof installFakeGPU> | undefined;
// Engine caches its shared device across instances; losing it evicts the cache.
afterEach(async () => { active?.loseDevice(); await macrotask(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(seed: number) {
  let random = seed * 2654435761 + 1 >>> 0;
  const pick = (limit: number) => { random = random * 1664525 + 1013904223 >>> 0; return (random >>> 8) % limit; };
  const gpu = active = installFakeGPU();
  const engine = new Engine({canvas: gpu.canvas, backend: 'webgpu'});
  const camera = new Camera({projection: 'perspective', aspect: 4 / 3, fov: 50});
  camera.position = [3, 2, 4]; camera.lookAt([0, 0, 0]);
  engine.camera = camera;
  const glass = () => new Mesh(createSphereGeometry(8, 6), new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0}));
  const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [.6, .6, .6]}));
  const spot = new SpotLight({intensity: 50, radius: 0, innerAngle: 25, outerAngle: 35});
  spot.position = [0, 3, 0]; spot.lookAt([0, 0, 0]);
  const scene = {meshes: [floor, glass()], lights: [spot] as unknown[], background: [0, 0, 0, 1]} as NonNullable<Engine['scene']>;
  engine.scene = scene;
  const final = new Render(engine, {maxSamples: 4, batchSamples: !!pick(2)});
  const loop = new RenderLoop(engine, {final, preview: pick(4) ? {maxSamples: 1} : false, coalesceSceneUpdates: !pick(2)});
  const other = pick(3) ? undefined : new Render(engine, {width: 32, height: 32, maxSamples: 2, samplingPattern: 'random'});
  return {gpu, engine, camera, scene, final, loop, other, pick, glass};
}

type Fixture = ReturnType<typeof setup>;
const caustics = [undefined, {lightTracing: true}, {photonMapping: true}, {lightTracing: true, photonMapping: true}];
const edits: ((f: Fixture) => void)[] = [
  f => { f.final.caustics = caustics[f.pick(4)]; },
  f => { if (f.loop.preview) f.loop.preview.caustics = caustics[f.pick(4)]; },
  f => { f.final.samplingPattern = (['sobol', 'random', 'zsobol'] as const)[f.pick(3)]; },
  f => { f.final.bevelSamples = 1 + f.pick(32); },
  f => { f.final.alphaBlendStrategy = f.pick(2) ? 'stochastic' : 'deterministic-source-over'; },
  f => { f.final.bounces = 1 + f.pick(8); },
  f => { f.final.resolutionScale = [.5, .75, 1][f.pick(3)]; },
  f => { f.engine.display.setSize(128 + 16 * f.pick(8), 96 + 16 * f.pick(8)); },
  f => { f.camera.position = [3 + f.pick(4) * .1, 2, 4]; f.camera.lookAt([0, 0, 0]); },
  f => { if (f.pick(2)) f.scene.meshes = [...f.scene.meshes, f.glass()]; else if (f.scene.meshes.length > 1) f.scene.meshes = f.scene.meshes.slice(0, -1); },
  f => { const material = f.scene.meshes[0].materials[0]; material.baseColor = [f.pick(10) / 10, .5, .5]; },
  f => { const material = f.scene.meshes[0].materials[0]; material.transmissionWeight = f.pick(2); material.coatWeight = f.pick(2); },
  f => { const material = f.scene.meshes[0].materials[0]; material.opacity = f.pick(2) ? 1 : .5; material.alphaMode = material.opacity < 1 ? 'blend' : 'opaque'; },
  f => { const light = new SphereLight({intensity: 5, radius: .1}); light.position = [1, 2, 1]; f.scene.lights = f.pick(2) ? [...f.scene.lights, light] : f.scene.lights.slice(0, 1); },
  f => { f.scene.background = [f.pick(10) / 10, 0, 0, 1]; },
  f => { const aov = (['depth', 'normal' as never, 'id', 'motion'] as const)[f.pick(4)]; if (aov === ('normal' as never)) { f.engine.display.channel = 'final'; return; } f.final.aovs = [aov]; if (f.loop.preview) f.loop.preview.aovs = [aov]; f.engine.display.channel = aov as never; },
  f => { f.engine.display.channel = 'final'; },
  f => { void f.final.setDenoiser(f.pick(2) ? {type: 'jnlm', schedule: (['converged', 'progressive', 'every-sample'] as const)[f.pick(3)]} : null).catch(() => {}); },
  f => { f.engine.display.toneMappingExposure = 1 + f.pick(4) * .25; },
  f => { f.gpu.state.failNextCompile = !f.pick(4); },
  f => { if (!f.pick(6)) f.gpu.loseDevice(); }
];

describe('RenderLoop edit liveness', () => {
  // Each seed interleaves edits, ticks and GPU completions on the real engine.
  it.each(Array.from({length: 150}, (_, seed) => seed))('renders the latest state after random edits (seed %i)', async seed => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = setup(seed);
    const {gpu, engine, final, loop, other, pick} = fixture;
    engine.on('error', error => errors.push(error.message));
    await engine.init();
    const history: string[] = [];
    for (let step = 0; step < 80; step++) {
      const action = pick(5);
      if (action <= 1) history.push(loop.tick());
      else if (action === 2) { const edit = pick(edits.length); history.push(`edit${edit}`); edits[edit](fixture); }
      else if (action === 3) { gpu.settle(false, pick(1000)); await macrotask(); }
      else { other?.refine(); }
      // Recovery creates a new pass while the lost pass's compilations finish.
      if (!gpu.state.losses) expect(gpu.state.traceRunning).toBeLessThanOrEqual(2);
    }
    // Stop editing. Every render must now finish or report why it cannot.
    gpu.state.failNextCompile = false;
    let status = loop.status, frames = 0;
    for (; frames < 200; frames++) {
      status = loop.tick(); other?.refine();
      gpu.settle(); await macrotask();
      if (!gpu.outstanding && (status === 'finished' || status === 'error') && !final.denoising) break;
    }
    // Surface-output channels finish on their own sample count.
    const rendered = engine.display.channel === 'final' ? final.samples >= final.maxSamples : final.aovSamplesRendered > 0;
    expect({status, frames: frames < 200, samples: rendered || status === 'error', tail: history.slice(-6), loopError: loop.lastError?.message, errors: errors.slice(-3)})
      .toMatchObject({frames: true, samples: true});
    expect(['finished', 'error']).toContain(status);
    loop.dispose(); other?.dispose(); engine.dispose();
  });
});
