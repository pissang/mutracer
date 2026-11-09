import type Engine from '../../src/Engine.js';
import RenderLoop from '../../src/RenderLoop.js';
import Sync from '../../src/Sync.js';
import Render from '../../src/Render.js';
import type Camera from '../../src/scene/Camera.js';
import type {Scene} from '../../src/scene/Scene.js';

/** Real-GPU allocation/fallback probe using only first-layer image operations. */
export async function measureProgressiveSwitches(engine: Engine, scene: Scene, camera: Camera) {
  engine.display.setSize(1024, 1024); engine.scene = scene; engine.camera = camera; engine.update(); await engine.init();
  const preview = new Render(engine, {resolutionScale: .5, maxSamples: 1, bounces: 2, bevel: false, dispersionWavelengths: 1, directLightCandidates: 2});
  const final = new Render(engine, {maxSamples: 2, timeBudgetMs: 1, maxTiles: 1, fallback: preview});
  const frames: {preview: boolean; samples: number; presentedTarget?: string; presentedComplete?: boolean}[] = [];
  async function complete(render: Render) {
    for (let attempts = 0; attempts < 2000; attempts++) {
      const status = render.refine(); const shown = engine.display.present(render); const diagnostics = engine.getDiagnostics();
      frames.push({preview: shown === preview, samples: render.samples, presentedTarget: diagnostics?.presentedTarget, presentedComplete: diagnostics?.presentedComplete});
      if (status === 'error') throw engine.lastError;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (render.samples >= 1) return;
    }
    throw new Error('Progressive switch did not complete.');
  }
  async function cycle() {preview.restart(); final.restart(); await complete(preview); await complete(final);}
  await cycle(); await cycle();
  const allocations = {textures: 0, buffers: 0, framebuffers: 0}; const restores: (() => void)[] = [];
  function count<T extends object, K extends keyof T>(owner: T, key: K, counter: keyof typeof allocations) {
    const original = owner[key], callable = original as (...args: unknown[]) => unknown;
    owner[key] = function(this: T, ...args: unknown[]) {allocations[counter]++; return callable.apply(this, args);} as T[K];
    restores.push(() => {owner[key] = original;});
  }
  if (engine.device) {count(engine.device, 'createTexture', 'textures'); count(engine.device, 'createBuffer', 'buffers');}
  else {const gl = engine.display.canvas.getContext('webgl2') as WebGL2RenderingContext; count(gl, 'createTexture', 'textures'); count(gl, 'createFramebuffer', 'framebuffers');}
  frames.length = 0;
  try {
    for (let i = 0; i < 10; i++) await cycle();
    await engine.device?.queue.onSubmittedWorkDone();
    return {backend: engine.backend, allocations, frames, diagnostics: engine.getDiagnostics()};
  } finally {restores.forEach(restore => restore()); preview.dispose(); final.dispose();}
}

/** Real-GPU loop-policy probe complementing the first-layer allocation probe. */
export async function measureRenderLoopSwitches(engine: Engine, scene: Scene, camera: Camera) {
  engine.display.setSize(1024, 1024); engine.scene = scene; engine.camera = camera; engine.update(); await engine.init();
  class Interaction extends Sync { moving = false; update() {} get active() {return this.moving;} }
  const sync = new Interaction(engine);
  const loop = new RenderLoop(engine, {sync, preview: {maxSamples: 1}, final: {maxSamples: 2, timeBudgetMs: 1, maxTiles: 1}});
  const frames: {changing: boolean; status: string; finalSamples: number; previewSamples: number; finalRefined: boolean; presentedTarget?: string; presentedComplete?: boolean}[] = [];
  let finalRefined = false;
  const refine = loop.final.refine.bind(loop.final);
  loop.final.refine = () => {finalRefined = true; return refine();};
  const frame = async () => {
    finalRefined = false; const status = loop.tick(); const diagnostics = engine.getDiagnostics();
    frames.push({changing: loop.changing, status, finalSamples: loop.final.samples, previewSamples: loop.preview!.samples, finalRefined,
      presentedTarget: diagnostics?.presentedTarget, presentedComplete: diagnostics?.presentedComplete});
    if (status === 'error') throw engine.lastError;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  };
  try {
    for (let iteration = 0; iteration < 10; iteration++) {
      sync.moving = true; camera.position = [iteration * .1, 0, 4];
      // Commit even when the previous iteration had a complete preview.
      await frame();
      for (let attempts = 0; attempts < 2000 && loop.preview!.samples < 1; attempts++) await frame();
      if (loop.preview!.samples < 1) throw new Error('Preview did not complete.');
      sync.moving = false; await frame();
      if (!finalRefined || loop.changing) throw new Error('Final did not begin in the interaction-ending tick.');
      for (let attempts = 0; attempts < 2000 && loop.status !== 'finished'; attempts++) await frame();
      if (loop.status !== 'finished') throw new Error('Final did not finish.');
    }
    await loop.converge({samples: 16, sampleSequenceOffset: 0});
    const pixels = await loop.final.readPixels('hdr');
    const control = new Render(engine, {maxSamples: 16});
    try {
      await control.converge({samples: 16, sampleSequenceOffset: 0}); const reference = await control.readPixels('hdr');
      let maxAbsoluteError = 0;
      for (let i = 0; i < pixels.data.length; i++) maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(pixels.data[i] - reference.data[i]));
      return {backend: engine.backend, frames, maxAbsoluteError, diagnostics: engine.getDiagnostics()};
    } finally {control.dispose();}
  } finally {loop.dispose(); sync.dispose();}
}
