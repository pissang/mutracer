import {afterAll, afterEach, describe, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine';
import RenderLoop from '../../src/RenderLoop';
import Render from '../../src/Render';
import Camera from '../../src/scene/Camera';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {SpotLight, SphereLight} from '../../src/main';
import {createPlaneGeometry, createSphereGeometry} from '../../src/main';
import {installFakeDocument, installFakeGPU, installFakeWebGL} from '../helpers/fakeGPU';

const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));
let active: ReturnType<typeof installFakeGPU> | undefined;
// Engine caches its shared device across instances; losing it evicts the cache.
afterEach(async () => { active?.loseDevice(); await macrotask(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(seed: number, sampleMs?: number) {
  const gpu = active = installFakeGPU({sampleMs});
  return {gpu, ...scene(seed, gpu.canvas, 'webgpu')};
}

function scene(seed: number, canvas: HTMLCanvasElement, backend: 'webgpu' | 'webgl') {
  let random = seed * 2654435761 + 1 >>> 0;
  const pick = (limit: number) => { random = random * 1664525 + 1013904223 >>> 0; return (random >>> 8) % limit; };
  const engine = new Engine({canvas, backend});
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
  return {engine, camera, scene, final, loop, other, pick, glass};
}

type Fixture = ReturnType<typeof setup>;
const caustics = [undefined, {lightTracing: true}, {photonMapping: true}, {lightTracing: true, photonMapping: true}];
const edits: ((f: Pick<Fixture, Exclude<keyof Fixture, 'gpu'>>) => void)[] = [
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
];
const gpuFaults: ((f: Fixture) => void)[] = [
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
      else if (action === 2) { const all = [...edits, ...gpuFaults], edit = pick(all.length); history.push(`edit${edit}`); all[edit](fixture); }
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

  // Offline output rejects on input changes, but must always settle and hand
  // the render back to the interactive loop.
  it.each(Array.from({length: 60}, (_, seed) => seed))('settles convergence during random edits (seed %i)', async seed => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = setup(seed);
    const {gpu, engine, final, loop, other, pick} = fixture;
    engine.on('error', () => {});
    await engine.init();
    for (let round = 0; round < 3; round++) {
      let settled: string | undefined;
      const controller = new AbortController();
      const options = {samples: 3, samplesPerBatch: 1 + pick(3), signal: controller.signal, timeoutMs: 60000};
      const task = pick(2) ? loop.converge(options) : final.converge(options);
      void task.then(() => { settled = 'resolved'; }, error => { settled = 'rejected: ' + error?.message; });
      for (let step = 0; step < 30 && !settled; step++) {
        const action = pick(6);
        if (action === 0) edits[pick(edits.length)](fixture);
        else if (action === 1) { try { loop.tick(); } catch { /* A direct converge rejects refine on its render. */ } }
        else if (action === 2) engine.update();
        else if (action === 3) gpu.settle(false, pick(1000));
        else if (action === 4) other?.refine();
        await macrotask();
      }
      if (!pick(3)) controller.abort();
      gpu.state.failNextCompile = false;
      for (let frame = 0; frame < 300 && !settled; frame++) { gpu.settle(); await macrotask(); }
      expect(settled).toBeDefined();
      // Afterwards the loop is usable with whatever state the edits left.
      engine.display.channel = 'final';
      let status = loop.status, frame = 0;
      for (; frame < 200; frame++) {
        status = loop.tick(); gpu.settle(); await macrotask();
        if (!gpu.outstanding && (status === 'finished' || status === 'error') && !final.denoising) break;
      }
      expect(frame).toBeLessThan(200);
      expect(status === 'error' || final.samples >= final.maxSamples).toBe(true);
    }
    loop.dispose(); other?.dispose(); engine.dispose();
  });

  // Timestamps turn on batching, refills and the adaptive tile grid.
  const speeds = [.4, 4, 18, 45, 300];
  const scheduling = {batches: 0, partialSamples: 0, refills: 0};
  it.each(Array.from({length: 75}, (_, seed) => seed))('keeps samples and finishes while scheduling work (seed %i)', async seed => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = installFakeDocument();
    const fixture = setup(seed, speeds[seed % speeds.length]);
    const {gpu, engine, final, loop, other, pick} = fixture;
    engine.on('error', () => {});
    final.batchSamples = seed % 3 !== 0;
    final.maxSamples = seed % 2 ? 48 : 8;
    await engine.init();

    // Every way this render may legitimately lose its samples.
    let restarts = 0;
    const spied = new WeakSet<object>();
    const restartKey = () => {
      const target = final._output;
      if (target && !spied.has(target)) {
        spied.add(target);
        const restart = target.restartSamples.bind(target);
        target.restartSamples = () => { restarts++; restart(); };
      }
      const {scene, camera} = engine._inputs;
      return `${scene}/${camera}/${engine._deviceGeneration}/${restarts}`;
    };
    let samples = 0, key = restartKey();
    const observe = () => {
      const nextKey = restartKey(), next = final.samples;
      if (nextKey === key) expect(next, 'samples dropped without a restart').toBeGreaterThanOrEqual(samples);
      samples = next; key = nextKey;
    };
    const frame = () => {
      const before = final.samples, submits = gpu.state.submits;
      const status = loop.tick();
      const added = final.samples - before;
      if (added > 1) scheduling.batches++;
      if (!added && gpu.state.submits > submits && status === 'converging' && before > 0) scheduling.partialSamples++;
      observe();
      return status;
    };
    let submitted = gpu.state.submits;

    const schedulingEdits: ((f: Fixture) => void)[] = [
      ...edits, ...gpuFaults,
      f => { f.gpu.state.sampleMs = speeds[f.pick(speeds.length)]; },
      f => { f.final.batchSamples = !f.final.batchSamples; },
      f => { f.final.timeBudgetMs = [8, 21, 60][f.pick(3)]; },
      f => { f.final.adaptiveResolution = f.pick(3) ? false : {targetFrameMs: 30, minScale: .25}; },
      () => { page.setHidden(!pick(2)); }
    ];
    for (let step = 0; step < 90; step++) {
      const action = pick(6);
      if (action <= 1) { submitted = gpu.state.submits; frame(); submitted = gpu.state.submits; }
      else if (action === 2) schedulingEdits[pick(schedulingEdits.length)](fixture);
      else if (action === 3) gpu.settle(false, pick(1000));
      else if (action === 4) other?.refine();
      else gpu.settle();
      await macrotask();
      // Work submitted without a tick came from a between-frame refill.
      if (gpu.state.submits > submitted && !other) scheduling.refills++;
      submitted = gpu.state.submits;
      observe();
    }

    // Stop editing. Tiles must finish, and the queue must drain.
    page.setHidden(false);
    gpu.state.failNextCompile = false;
    final.adaptiveResolution = false;
    // A slow scene with a small budget legitimately takes many frames per sample.
    final.maxSamples = Math.min(final.maxSamples, final.samples + 3);
    let status = loop.status, frames = 0;
    for (; frames < 1500; frames++) {
      status = frame(); other?.refine();
      gpu.settle(); await macrotask();
      if (!gpu.outstanding && (status === 'finished' || status === 'error') && !final.denoising) break;
    }
    expect(status === 'finished' || status === 'error', `ended ${status} at ${final.samples}`).toBe(true);
    if (status === 'finished' && engine.display.channel === 'final') expect(final.samples).toBeGreaterThanOrEqual(final.maxSamples);
    if (status !== 'error') await expect(final.whenReadyToRefine()).resolves.toBe(false);
    loop.dispose(); other?.dispose(); engine.dispose();
  });

  it.each(Array.from({length: 40}, (_, seed) => seed))('renders the latest state on WebGL after random edits (seed %i)', async seed => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFakeDocument();
    const gl = installFakeWebGL();
    const fixture = scene(seed, gl.canvas, 'webgl');
    const {engine, final, loop, other, pick} = fixture;
    engine.on('error', () => {});
    await engine.init();
    for (let step = 0; step < 70; step++) {
      const action = pick(6);
      if (action <= 1) loop.tick();
      else if (action === 2) edits[pick(edits.length)](fixture);
      else if (action === 3) gl.settle(false, pick(1000));
      else if (action === 4) other?.refine();
      else if (!pick(8)) { gl.loseContext(); await macrotask(); loop.tick(); gl.restoreContext(); }
      await macrotask();
    }
    let status = loop.status, frames = 0;
    for (; frames < 300; frames++) {
      status = loop.tick(); other?.refine();
      gl.settle(); await macrotask();
      if (!gl.outstanding && (status === 'finished' || status === 'error') && !final.denoising) break;
    }
    expect(status === 'finished' || status === 'error', `ended ${status} at ${final.samples}: ${loop.lastError?.message ?? engine.lastError?.message}`).toBe(true);
    if (status === 'finished' && engine.display.channel === 'final') expect(final.samples).toBeGreaterThanOrEqual(final.maxSamples);
    loop.dispose(); other?.dispose(); engine.dispose();
  });

  it('renders a surface output when it is the first thing WebGL draws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFakeDocument();
    const gl = installFakeWebGL();
    const {engine, final, loop} = scene(1, gl.canvas, 'webgl');
    await engine.init();
    final.aovs = ['depth']; if (loop.preview) loop.preview.aovs = ['depth'];
    engine.display.channel = 'depth';
    for (let frame = 0; frame < 20 && !final.aovSamplesRendered; frame++) { loop.tick(); gl.settle(); await macrotask(); }
    expect(final.aovSamplesRendered).toBeGreaterThan(0);
    loop.dispose(); engine.dispose();
  });

  afterAll(() => {
    // A green run proves little if the randomness never reached these paths.
    expect(scheduling.batches, 'several samples in one frame').toBeGreaterThan(0);
    expect(scheduling.partialSamples, 'frames that finish only part of a sample').toBeGreaterThan(0);
    expect(scheduling.refills, 'samples between frames').toBeGreaterThan(0);
  });
});
