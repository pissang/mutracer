// Deterministic noisy indoor shot for temporal denoising at 1–3 spp per frame.
// Frame i renders time i / fps with sample sequence offset i × spp.
import * as mutracer from '@meimu/mutracer';
import { Engine, Render } from '@meimu/mutracer';
import { TemporalDenoiser, type TemporalFrame } from '@meimu/mutracer/temporal';
import { createTemporalStressShot, temporalStressTiming } from './shared/temporalStressShot';
import { captureOfflineGeometry, OfflineGeometryHistory, offlineSampleCap, offlineSampleTileSize } from '../src/temporal/offlineSamplePlan';

interface Settings {
  spp: number;
  mode: 'offline' | 'interactive' | 'off';
  reflectionMotion: boolean;
  accumulateGuides: boolean;
  depthOfField: boolean;
  historyRadius?: number;
  postRadius?: number;
  stabilizeSparkle?: boolean;
  temporalSampleBudget?: number;
  temporalSampleFloor?: number;
  reflectionAwareSampling?: boolean;
  sampleStride?: number;
}

const params = new URLSearchParams(location.search);
const [width, height] = (params.get('size') ?? '1280x720').split('x').map(Number);
const canvas = document.querySelector<HTMLCanvasElement>('#main')!;
const status = document.querySelector<HTMLElement>('#status')!;
const spp = document.querySelector<HTMLSelectElement>('#spp')!;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
const reflectionMotion = document.querySelector<HTMLInputElement>('#reflection-motion')!;
const accumulateGuides = document.querySelector<HTMLInputElement>('#accumulate-guides')!;
const dof = document.querySelector<HTMLInputElement>('#dof')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const scrubber = document.querySelector<HTMLInputElement>('#frame')!;

if (params.has('spp')) spp.value = params.get('spp')!;
if (params.has('mode')) mode.value = params.get('mode')!;
reflectionMotion.checked = params.get('reflectionMotion') === '1';
accumulateGuides.checked = params.get('accumulateGuides') === '1';
if (params.has('dof')) dof.checked = params.get('dof') !== '0';

const engine = new Engine({ canvas, backend: params.has('webgl') ? 'webgl' : 'auto' });
const shot = createTemporalStressShot(mutracer);
engine.scene = shot.scene;
engine.camera = shot.camera;
engine.display.setSize(width, height);
const render = new Render(engine, { width, height, bounces: 6 });
scrubber.max = String(shot.frameCount - 1);

const settings = (): Settings => ({
  spp: Number(spp.value),
  mode: mode.value as Settings['mode'],
  reflectionMotion: reflectionMotion.checked,
  accumulateGuides: accumulateGuides.checked,
  depthOfField: dof.checked
});

const geometryWidth = Math.ceil(width / 16) * (16 / offlineSampleTileSize);
const geometryHeight = Math.ceil(height / 16) * (16 / offlineSampleTileSize);
let captureTiming: {pilotMs: number; geometryMs: number[]; allocationMs: number; renderMs: number[];
  beautySamples: number[]; belowMinimum: number[]} | undefined;

async function planSampling(options: Settings, start: number, end: number, stopped: () => boolean) {
  const aovs = ['id', 'motion', 'centerPosition'] as const;
  const predictReflection = options.reflectionAwareSampling === true;
  const geometry = new Render(engine, {width: geometryWidth, height: geometryHeight, maxSamples: 1,
    aovs: [...aovs, ...(predictReflection ? ['roughness'] as const : [])], bounces: 6});
  if (predictReflection && options.reflectionMotion) geometry._attachTemporal(aovs, true);
  const history = new OfflineGeometryHistory(geometryWidth, geometryHeight);
  const geometryMs = [];
  let previousRevision = engine._temporalRevision;
  try {
    for (let i = start; i < end; i++) {
      const started = performance.now();
      shot.setTime(i / temporalStressTiming.fps, {depthOfField: options.depthOfField});
      engine.update();
      const frame = await captureOfflineGeometry(geometry, stopped, predictReflection);
      if (!frame) return;
      const changed = engine._temporalRevision !== previousRevision;
      history.add(frame, i === Math.ceil(temporalStressTiming.cut * temporalStressTiming.fps) || (predictReflection && changed));
      previousRevision = engine._temporalRevision;
      geometryMs.push(performance.now() - started);
    }
    const started = performance.now();
    const plans = history.samplePlans(geometryWidth * offlineSampleTileSize, geometryHeight * offlineSampleTileSize,
      options.spp, options.temporalSampleBudget!, options.historyRadius ?? 8, options.temporalSampleFloor ?? 10);
    return {plans, geometryMs, allocationMs: performance.now() - started};
  } finally { geometry.dispose(); }
}

/** Renders frames [start, end) and yields each displayable result with its frame index. */
async function* frames(options: Settings, start: number, end: number, stopped: () => boolean) {
  const started = performance.now();
  if (options.temporalSampleBudget !== undefined && (engine.backend !== 'webgpu' || options.mode !== 'offline' ||
    options.accumulateGuides || options.spp !== 3 || !Number.isFinite(options.temporalSampleBudget) ||
    options.temporalSampleBudget < options.spp || options.temporalSampleBudget > offlineSampleCap)) {
    throw new Error('The temporal sampling experiment needs offline WebGPU history without accumulated guides and a total budget of at least 3 spp.');
  }
  const planning = options.temporalSampleBudget === undefined ? undefined : await planSampling(options, start, end, stopped);
  if (stopped()) return;
  const timing = {pilotMs: planning ? performance.now()-started : 0, geometryMs: planning?.geometryMs ?? [],
    allocationMs: planning?.allocationMs ?? 0,
    renderMs: [] as number[], beautySamples: [] as number[], belowMinimum: [] as number[]};
  if (params.has('capture')) captureTiming = timing;
  // Temporal denoising requires WebGPU; WebGL shows the raw frames.
  const temporal = options.mode === 'off' || engine.backend !== 'webgpu' ? undefined : new TemporalDenoiser(engine, {
    mode: options.mode as 'offline' | 'interactive',
    reflectionMotion: options.reflectionMotion,
    accumulateGuides: options.accumulateGuides,
    historyRadius: options.historyRadius,
    postRadius: options.postRadius,
    stabilizeSparkle: options.stabilizeSparkle,
    denoiser: { type: 'oidn', model: 'cleanAuxLarge', weightsBaseUrl: '/oidn/weights/' }
  });
  if (planning) temporal!._configureOfflineSampling({tileSize: offlineSampleTileSize});
  const detach = temporal?.attach(render);
  render.maxSamples = options.spp;
  try {
    for (let i = start; i < end && !stopped(); i++) {
      const startFrame = performance.now();
      shot.setTime(i / temporalStressTiming.fps, { depthOfField: options.depthOfField });
      engine.update();
      const plan = planning?.plans[i - start];
      const sampleSequenceOffset = i * (options.sampleStride ?? (planning ? 32 : options.spp));
      let average = options.spp;
      if (plan) {
        render.maxSamples = plan.targets.reduce((cap, target) => Math.max(cap, target), options.spp);
        const result = await render._convergeWithSampleTiles({samples: offlineSampleCap, sampleSequenceOffset}, plan);
        average = result.averageSamplesPerPixel;
        await temporal!.push(render);
      } else {
        await render.converge({samples: options.spp, sampleSequenceOffset});
        await temporal?.push(render);
      }
      if (captureTiming === timing) {
        timing.renderMs.push(performance.now() - startFrame);
        timing.beautySamples.push(average);
        timing.belowMinimum.push(plan?.belowMinimum ?? 0);
      }
      if (!temporal) { yield { image: render as Render | TemporalFrame, index: i }; continue; }
      for await (const frame of temporal.drain()) yield { image: frame, index: start + frame.index };
    }
    if (temporal) for await (const frame of temporal.flush()) yield { image: frame, index: start + frame.index };
  } finally {
    detach?.();
    temporal?.dispose();
  }
}

// Interactive playback. Every restart begins a new history at the next frame.
let generation = 0;
let playing = false;
let shown = 0;
let queue = Promise.resolve();

function show(image: Render | TemporalFrame, index: number) {
  if (image instanceof Render) engine.display.present(image);
  else engine.display.present(image);
  shown = index;
  scrubber.value = String(index);
  const backend = engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2';
  status.textContent = `${index + 1} / ${shot.frameCount} · ${backend}`;
}

function start(from: number, loop: boolean) {
  const token = ++generation;
  queue = queue.then(async () => {
    try {
      await engine.init();
      for (let begin = from; token === generation;) {
        const end = loop ? shot.frameCount : begin + 1;
        for await (const { image, index } of frames(settings(), begin, end, () => token !== generation)) show(image, index);
        if (!loop || token !== generation) break;
        begin = 0;
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      console.error(error);
    }
  });
}

function setPlaying(value: boolean) {
  playing = value;
  play.textContent = value ? 'Pause' : 'Play';
  if (value) start(shown + 1 < shot.frameCount ? shown + 1 : 0, true);
  else generation++;
}

play.addEventListener('click', () => setPlaying(!playing));
scrubber.addEventListener('input', () => {
  playing = false;
  play.textContent = 'Play';
  shown = Number(scrubber.value);
  start(shown, false);
});
for (const control of [spp, mode, reflectionMotion, accumulateGuides, dof]) {
  control.addEventListener('change', () => playing ? start(shown + 1 < shot.frameCount ? shown + 1 : 0, true) : start(shown, false));
}
void engine.init().then(() => {
  if (engine.backend !== 'webgpu') mode.disabled = reflectionMotion.disabled = accumulateGuides.disabled = true;
  if (!params.has('capture')) start(0, false);
});
window.addEventListener('pagehide', () => { generation++; render.dispose(); engine.dispose(); });

// Headless capture: `open(settings, start, end)`, then call `next()` until it
// returns null. Each result holds a PNG data URL and an FNV-1a hash of the HDR pixels.
let capture: AsyncGenerator<{ image: Render | TemporalFrame; index: number }> | undefined;
async function hash(image: Render | TemporalFrame) {
  const { data } = image instanceof Render ? await image.readPixels('hdr') : await image.readPixels('denoised');
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let value = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 0x01000193);
  return (value >>> 0).toString(16).padStart(8, '0');
}
Object.assign(window, {
  temporalStress: {
    frameCount: shot.frameCount,
    cutFrame: shot.cutFrame,
    timing: () => captureTiming,
    async open(options: Partial<Settings>, begin = 0, end = shot.frameCount) {
      generation++;
      await queue;
      await engine.init();
      await capture?.return(undefined);
      capture = frames({ ...settings(), ...options }, begin, end, () => false);
      return engine.backend;
    },
    async next(saveFrames: readonly (readonly [number, number])[] = []) {
      let result = await capture?.next();
      while (result && !result.done && saveFrames.length) {
        const { index } = result.value;
        if (saveFrames.some(([first, last]) => index >= first && index <= last)) break;
        result = await capture?.next();
      }
      if (!result || result.done) return null;
      const { image, index } = result.value;
      const blob = image instanceof Render ? await engine.display.toBlob(image) : await engine.display.toBlob(image);
      const png = await new Promise<string>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      show(image, index);
      return { index, png, hash: await hash(image) };
    }
  }
});
