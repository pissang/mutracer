import { afterEach, describe, expect, it, vi } from 'vitest';
import Render from '../../src/Render';
import { renderFixture } from '../helpers/renderPipeline';

function adaptiveFrames() {
  let id = 0; const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frames.set(++id, callback); return id;});
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  return () => {const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(performance.now()));};
}
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('independent Render', () => {
  it.each([false, true])('adapts from the whole tiled sample, including fallback rendering (%s)', fallback => {
    const frame = adaptiveFrames();
    let now = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const {engine} = renderFixture({tiles: 4, fits: false});
    const preview = new Render(engine, {maxSamples: 1, resolutionScale: .5, adaptiveResolution: {targetFrameMs: 20, minScale: .25}});
    const final = new Render(engine, {fallback: preview});
    const refine = () => fallback ? final.refine() : preview.refine();
    refine(); now = 20; refine(); now = 40; refine(); now = 60; refine();
    expect(preview.width).toBe(400);
    // Apply the completed measurement once on the next preview frame.
    frame(); preview.refine(); expect(preview.width).toBe(250);
    engine.dispose(); clock.mockRestore();
  });
  it('adapts a denoised preview before continuous camera edits restart it', async () => {
    const frame = adaptiveFrames();
    let now = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const {engine, camera} = renderFixture({tiles: 4});
    const preview = new Render(engine, {maxSamples: 1, resolutionScale: .5, adaptiveResolution: {targetFrameMs: 20, minScale: .25}, denoiser: {type: 'jnlm'}});
    preview.refine(); now = 20; preview.refine(); now = 40; preview.refine(); now = 60; preview.refine();
    await new Promise(resolve => setTimeout(resolve, 0));
    frame();
    camera.position = [1, 0, 0]; engine.update(); preview.refine();
    expect(preview.width).toBe(250);
    engine.dispose(); clock.mockRestore();
  });
  it('includes inference latency without resizing a preview while its filter is pending', async () => {
    const frame = adaptiveFrames();
    let now = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const {engine, camera, targets} = renderFixture();
    const preview = new Render(engine, {maxSamples: 1, resolutionScale: .5, adaptiveResolution: {targetFrameMs: 20, minScale: .25}, denoiser: {type: 'jnlm'}});
    preview.refine(); let complete!: (value: boolean) => void;
    vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    await new Promise(resolve => setTimeout(resolve, 0));
    now = 80; preview.refine(); expect(preview.width).toBe(400); expect(preview.denoising).toBe(true);
    complete(true); await new Promise(resolve => setTimeout(resolve, 0));
    frame();
    camera.position = [1, 0, 0]; engine.update(); preview.refine(); expect(preview.width).toBe(200);
    engine.dispose(); clock.mockRestore();
  });
  it('adapts below quarter resolution from display latency and restores quality gradually', () => {
    const frame = adaptiveFrames(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const {engine, camera} = renderFixture({frameTimeMs: 2});
    const preview = new Render(engine, {maxSamples: 1, resolutionScale: .5, adaptiveResolution: {targetFrameMs: 20, minScale: .0625}});
    preview.refine(); now = 320; frame();
    const next = (delay: number) => {camera.position = [now, 0, 0]; engine.update(); preview.refine(); now += delay; frame();};
    for (let i = 0; i < 3; i++) {next(5); expect(preview.width).toBe(100);}
    next(5); next(5); expect(preview.width).toBe(125);
    next(2000); next(5); expect(preview.width).toBe(50);
    engine.dispose();
  });
  it('honors an explicit adaptive minimum and cancels scheduled feedback on disposal', () => {
    const frame = adaptiveFrames(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const {engine} = renderFixture({frameTimeMs: 2});
    const preview = new Render(engine, {maxSamples: 1, resolutionScale: .5, adaptiveResolution: {targetFrameMs: 20, minScale: .25}});
    preview.refine(); now = 2000; frame(); preview.refine(); expect(preview.width).toBe(200);
    preview.dispose(); expect(() => frame()).not.toThrow(); engine.dispose();
  });
  it('keeps final and preview resolution independent on a full-size display', () => {
    const {engine} = renderFixture(); engine.display.setSize(800, 600);
    const preview = new Render(engine, {resolutionScale: .5});
    const final = new Render(engine, {resolutionScale: .25, fallback: preview});
    preview.refine(); final.refine();
    expect([preview.width, preview.height, final.width, final.height]).toEqual([400, 300, 200, 150]);
    final.resolutionScale = 1; final.refine(); preview.refine();
    expect([preview.width, preview.height, final.width, final.height]).toEqual([400, 300, 800, 600]);
    expect([engine.display.canvas.width, engine.display.canvas.height]).toEqual([800, 600]); engine.dispose();
  });
  it('accumulates three interleaved outputs and selects the requested read/present target', async () => {
    const {engine, targets, operations} = renderFixture();
    const a = new Render(engine), b = new Render(engine), c = new Render(engine, {width: 256, height: 256});
    a.refine(); b.refine(); c.refine(); a.refine(); b.refine(); a.refine();
    expect([a.samples, b.samples, c.samples]).toEqual([3, 2, 1]);
    expect((await a.readPixels()).data.slice(0, 2)).toEqual(new Float32Array([1, 3]));
    expect((await c.readPixels()).width).toBe(256);
    expect(engine.display.present(b)).toBe(b);
    expect(operations.filter(o => o.kind === 'present').map(o => o.id)).toEqual([targets[1].label]);
    c.dispose(); expect(targets[2].dispose).toHaveBeenCalledOnce();
    a.refine(); expect(a.samples).toBe(4); expect(() => c.refine()).toThrow('disposed');
    engine.dispose();
  });
  it('uses committed camera state until update and restarts all renders afterwards', () => {
    const {engine, camera, targets, operations} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    a.refine(); b.refine(); camera.position = [3, 0, 1]; a.refine();
    expect(a.samples).toBe(2); expect(operations.filter(o => o.kind === 'draw').at(-1)?.camera?.position).toEqual([0, 0, 0]);
    expect(engine.update()).toBe(true); expect([a.samples, b.samples]).toEqual([0, 0]);
    a.refine(); b.refine(); expect([a.samples, b.samples]).toEqual([1, 1]);
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(2);
    expect(operations.filter(o => o.kind === 'draw').at(-1)?.camera?.position).toEqual([3, 0, 1]);
    expect(engine.update()).toBe(false); engine.dispose();
  });
  it('invalidates only the render whose image settings changed, including transmissive alpha', () => {
    const {engine, targets} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    a.refine(); b.refine(); a.bounces = 8; a.refine(); b.refine(); expect([a.samples, b.samples]).toEqual([1, 2]);
    a.transmissiveOutputAlphaMin = .25; a.refine(); expect(a.samples).toBe(1);
    expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({transmissiveOutputAlphaMin: .25}));
    engine.display.toneMappingExposure = 2; engine.display.present(a); expect(a.samples).toBe(1);
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(3); engine.dispose();
  });
  it('resizes scaled outputs and keeps fixed dimensions independent of the canvas', () => {
    const {engine} = renderFixture(); const a = new Render(engine, {resolutionScale: .5}), b = new Render(engine, {width: 256, height: 256});
    a.refine(); b.refine(); expect([a.width, a.height, b.width, b.height]).toEqual([400, 300, 256, 256]);
    engine.display.setSize(1024, 768); a.refine(); b.refine(); expect([a.width, a.height, b.width, b.height]).toEqual([512, 384, 256, 256]);
    expect([a.samples, b.samples]).toEqual([1, 2]); expect(() => {b.resolutionScale = .5;}).toThrow('Fixed-size');
    expect(() => new Render(engine, {width: 10} as never)).toThrow('width and height'); engine.dispose();
  });
  it('changes execution budgets without restarting accumulated input', () => {
    const {engine} = renderFixture(); const render = new Render(engine); render.refine();
    render.timeBudgetMs = 50; render.maxTiles = 1; render.batchSamples = true; render.refine();
    expect(render.samples).toBe(2); engine.dispose();
  });
  it('applies refine overrides for one call without mutating settings or restarting samples', () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine); render.refine();
    const budget = vi.fn(); Object.assign(targets[0], {setRealtimeBatchBudget: budget});
    render.refine(undefined, {batchSamples: true, targetBatchTimeMs: 4});
    expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({batchSamples: true}));
    expect(budget).toHaveBeenLastCalledWith(4); expect(render.batchSamples).toBe(false);
    render.refine(); expect(render.samples).toBe(3);
    expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({batchSamples: false}));
    expect(budget).toHaveBeenLastCalledWith(Infinity); expect(targets[0].restartSamples).toHaveBeenCalledOnce();
    engine.dispose();
  });
  it('keeps allowMultipleSamplesPerFrame as a deprecated alias of batchSamples', () => {
    const {engine} = renderFixture(); const render = new Render(engine, {allowMultipleSamplesPerFrame: true});
    expect(render.batchSamples).toBe(true);
    render.allowMultipleSamplesPerFrame = false; expect(render.batchSamples).toBe(false);
    Object.assign(render, {allowMultipleSamplesPerFrame: true}); expect(render.batchSamples).toBe(true);
    expect(new Render(engine, {batchSamples: false, allowMultipleSamplesPerFrame: true}).batchSamples).toBe(false);
    engine.dispose();
  });
  it('defers resolving only for the refine call that requests it', () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine); render.refine();
    const defer = vi.fn(); Object.assign(targets[0], {setRealtimeDeferPostProcess: defer});
    render.refine(undefined, {deferResolve: true}); expect(defer).toHaveBeenLastCalledWith(true); expect(render.samples).toBe(2);
    render.refine(); expect(defer).toHaveBeenLastCalledWith(false); engine.dispose();
  });
  it('exposes GPU sample timing only for a current, live render', () => {
    const {engine, camera, targets} = renderFixture(); const render = new Render(engine);
    expect(render.gpuSampleTimeMs).toBeUndefined(); render.refine();
    Object.assign(targets[0], {getRealtimeSampleTime: () => 2}); expect(render.gpuSampleTimeMs).toBe(2);
    camera.position = [1, 0, 0]; engine.update(); expect(render.gpuSampleTimeMs).toBeUndefined();
    render.refine(); expect(render.gpuSampleTimeMs).toBe(2);
    render.dispose(); expect(render.gpuSampleTimeMs).toBeUndefined(); engine.dispose();
  });
  it('can await sampling capacity without submitting work and rejects waiting after disposal', async () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine);
    expect(await render.whenReadyToRefine()).toBe(false); expect(targets).toHaveLength(0);
    render.refine(); let complete!: () => void;
    const pending = new Promise<boolean>(resolve => {complete = () => resolve(true);});
    Object.assign(targets[0], {whenTraceAvailable: () => pending});
    const ready = render.whenReadyToRefine(); expect(targets[0].trace).toHaveBeenCalledOnce();
    complete(); expect(await ready).toBe(true);
    Object.assign(targets[0], {whenTraceAvailable: () => Promise.resolve(false)});
    expect(await render.whenReadyToRefine()).toBe(false);
    render.dispose(); expect(() => render.whenReadyToRefine()).toThrow('disposed'); engine.dispose();
  });
  it('returns false on WebGL without waiting for display or denoising work', async () => {
    const {engine} = renderFixture({backend: 'webgl'}); const render = new Render(engine);
    render.refine(); expect(await render.whenReadyToRefine()).toBe(false); engine.dispose();
  });

  it.each([0, -1, NaN, Infinity])('rejects an invalid realtime queue budget (%s) and restores subsequent calls', targetBatchTimeMs => {
    const {engine} = renderFixture(); const render = new Render(engine);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(render.refine(undefined, {targetBatchTimeMs})).toBe('error');
    expect(engine.lastError?.message).toContain('targetBatchTimeMs');
    expect(render.refine()).toBe('converging'); expect(engine.lastError).toBeUndefined(); engine.dispose();
  });
  it('uses independent restarts and terminal sample counts', () => {
    const {engine} = renderFixture(); const a = new Render(engine, {maxSamples: 2}), b = new Render(engine);
    expect(a.refine()).toBe('converging'); expect(a.refine()).toBe('finished'); expect(a.converged).toBe(true);
    b.refine(); a.restart(); expect(a.samples).toBe(0); expect(b.samples).toBe(1); a.refine(); expect(a.samples).toBe(1); engine.dispose();
  });
});

describe('fallback', () => {
  it('fills a stale fallback once when the first final sample will exceed the frame budget', () => {
    const {engine, targets} = renderFixture({tiles: 3, fits: false});
    const preview = new Render(engine), final = new Render(engine, {fallback: preview});
    final.refine(); final.refine(); final.refine();
    expect(targets[1].trace).toHaveBeenCalledTimes(3); expect(final.samples).toBe(1); expect(preview.samples).toBe(1);
    final.refine(); expect(targets[1].trace).toHaveBeenCalledTimes(3); engine.dispose();
  });
  it('does not refine a current fallback or one unnecessary for a fast final', () => {
    const {engine, targets} = renderFixture({fits: false});
    const preview = new Render(engine), final = new Render(engine, {fallback: preview});
    preview.refine(); final.refine(); expect(targets[0].trace).toHaveBeenCalledOnce(); engine.dispose();
    const f = renderFixture(); const p = new Render(f.engine), r = new Render(f.engine, {fallback: p}); r.refine();
    expect(p.samples).toBe(0); f.engine.dispose();
  });
  it('rejects chains, cycles and foreign-engine fallbacks at construction and mutation', () => {
    const {engine} = renderFixture(); const other = renderFixture();
    const a = new Render(engine), b = new Render(engine, {fallback: a});
    expect(() => new Render(engine, {fallback: b})).toThrow('fallback');
    expect(() => {a.fallback = new Render(engine);}).toThrow('Fallback renders');
    expect(() => {a.fallback = a;}).toThrow('Fallback');
    expect(() => new Render(engine, {fallback: new Render(other.engine)})).toThrow('same engine');
    engine.dispose(); other.engine.dispose();
  });
});

describe('converge selects one render', () => {
  it('uses a camera copy, preserves the engine camera and excludes other targets', async () => {
    const {engine, camera, targets, operations} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    b.refine(); const exportCamera = camera.clone(); exportCamera.position = [8, 1, 2];
    const pending = a.converge({samples: 4, camera: exportCamera, sampleSequenceOffset: 19}); exportCamera.position = [9, 9, 9];
    expect(() => a.refine()).toThrow('converge'); b.refine();
    const result = await pending; expect(result.samples).toBe(4); expect(a.samples).toBe(4); expect(b.samples).toBe(2);
    expect(engine.camera).toBe(camera); expect(camera.position).toEqual([0, 0, 0]);
    expect(operations.filter(o => o.kind === 'draw' && o.id === targets[1].label).every(o => o.camera?.position[0] === 8)).toBe(true);
    expect((await a.readPixels()).data.slice(0, 2)).toEqual(new Float32Array([2, 4]));
    a.refine(); expect(a.samples).toBe(1); expect(operations.filter(o => o.kind === 'draw').at(-1)?.camera?.position).toEqual([0, 0, 0]); engine.dispose();
  });
  it('rejects an engine input update and permits the other render to use it', async () => {
    const {engine, camera} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    await expect(a.converge({samples: 4, onProgress: () => {camera.position = [3, 2, 1]; engine.update();}})).rejects.toThrow('inputs changed');
    expect(a.status).toBe('error'); b.refine(); expect(b.samples).toBe(1); engine.dispose();
  });
  it('honors abort, timeout and WebGL adaptive fail-soft', async () => {
    const {engine} = renderFixture({backend: 'webgl'}); const render = new Render(engine);
    const controller = new AbortController(); const reason = new Error('cancel'); controller.abort(reason);
    await expect(render.converge({samples: 4, signal: controller.signal})).rejects.toBe(reason);
    const result = await render.converge({samples: 2, adaptiveSampling: {pilotSamples: 8}}); expect(result.adaptiveSampling).toBe(false); expect(result.samples).toBe(2);
    engine.dispose();
    const f = renderFixture({tiles: Infinity}); const r = new Render(f.engine); await expect(r.converge({samples: 1, timeoutMs: 1})).rejects.toThrow('Timed out'); f.engine.dispose();
  });
  it('runs the pilot on this target with a disjoint final sequence', async () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine); render.refine();
    const history = {width: 1, height: 1, tileSize: 1, columns: 1, rows: 1, meanLuminance: new Float32Array(1), variance: new Float32Array(1), sampleTargets: new Uint32Array(1)};
    vi.mocked(targets[0].prepareOfflineAdaptiveSampling).mockResolvedValue({maximumTarget: 3, averageTarget: 2, history});
    const result = await render.converge({samples: 8, adaptiveSampling: {pilotSamples: 2}, sampleSequenceOffset: 10});
    expect(result).toMatchObject({samples: 3, averageSamplesPerPixel: 2, pilotSamples: 2, adaptiveSampling: true});
    expect(targets[0].setOfflineRenderOptions).toHaveBeenCalledWith(expect.objectContaining({sampleSequenceOffset: 12})); engine.dispose();
  });
});


describe('converge batches', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('runs deterministic fixed-spp batches without animation-frame waits', async () => {
    const raf = vi.fn(() => {throw new Error('Unexpected animation-frame wait');});
    vi.stubGlobal('requestAnimationFrame', raf);
    const {engine, targets} = renderFixture(); const render = new Render(engine);
    expect(await render.converge({samples: 12, samplesPerBatch: 4, sampleSequenceOffset: 37})).toEqual({
      samples: 12, averageSamplesPerPixel: 12, pilotSamples: 0, adaptiveSampling: false,
    });
    expect(targets[0].trace).toHaveBeenCalledTimes(3);
    expect(targets[0].setOfflineRenderOptions).toHaveBeenNthCalledWith(1, {samplesPerBatch: 4, deferPostProcess: true, sampleSequenceOffset: 37});
    expect(targets[0].setOfflineRenderOptions).toHaveBeenLastCalledWith({samplesPerBatch: 0, deferPostProcess: false, sampleSequenceOffset: 0});
    expect(raf).not.toHaveBeenCalled(); engine.dispose();
  });
  it.each([[undefined, 0], [0, 3], [100, 1], [500, 0]] as const)('throttles intermediate resolves at previewIntervalMs=%s', async (previewIntervalMs, resolves) => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const {engine, targets} = renderFixture(); const render = new Render(engine);
    vi.spyOn(engine.device!.queue, 'onSubmittedWorkDone').mockImplementation(async () => {clock += 60;});
    await render.converge({samples: 16, samplesPerBatch: 4, previewIntervalMs});
    expect(targets[0].drawPostProcess).toHaveBeenCalledTimes(resolves);
    expect(targets[0].present).not.toHaveBeenCalled(); engine.dispose();
  });
  it('adapts WebGPU batch size from measured queue completion time', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const {engine, targets} = renderFixture(); const render = new Render(engine);
    const durations = [5, 10, 80, 20];
    vi.spyOn(engine.device!.queue, 'onSubmittedWorkDone').mockImplementation(async () => {clock += durations.shift() ?? 0;});
    await render.converge({samples: 9, samplesPerBatch: 8, targetBatchTimeMs: 30});
    expect(vi.mocked(targets[0].setOfflineRenderOptions).mock.calls.map(([options]) => options.samplesPerBatch)).toEqual([1, 2, 4, 2, 0]);
    engine.dispose();
  });
  it('uses GPU-generated adaptive targets without full pilot readback', async () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine); render.refine();
    const history = {width: 1, height: 1, tileSize: 1, columns: 1, rows: 1,
      meanLuminance: new Float32Array([.5]), variance: new Float32Array([.01]), sampleTargets: new Uint32Array([18])};
    vi.mocked(targets[0].prepareOfflineAdaptiveSampling).mockResolvedValue({maximumTarget: 18, averageTarget: 12.5, history});
    expect(await render.converge({samples: 32, samplesPerBatch: 8, sampleSequenceOffset: 100, adaptiveSampling: {pilotSamples: 4, tileSize: 8}})).toEqual({
      samples: 18, averageSamplesPerPixel: 12.5, pilotSamples: 4, varianceHistory: history, adaptiveSampling: true,
    });
    expect(targets[0].prepareOfflineAdaptiveSampling).toHaveBeenCalledWith({pilotSamples: 4, tileSize: 8, maxSamples: 32});
    expect(targets[0].setVarianceMoments).toHaveBeenCalledWith(true);
    expect(targets[0].setOfflineRenderOptions).toHaveBeenCalledWith({samplesPerBatch: 8, deferPostProcess: true, sampleSequenceOffset: 104});
    expect(targets[0].readOutput).not.toHaveBeenCalled(); engine.dispose();
  });
});
