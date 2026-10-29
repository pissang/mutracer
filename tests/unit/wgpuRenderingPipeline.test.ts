import Engine from '../../src/Engine';
import {expectDataOnlyDiagnostics} from '../helpers/diagnostics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Camera from '../../src/scene/Camera';
import {makeWGPURenderTargets} from '../../src/renderer/WGPURenderingPipeline';
import WGPUBloomPass from '../../src/renderer/WGPUBloomPass';
import type { OIDNWeb } from '../../src/renderer/denoiser';

// Keep the real pipeline and tile scheduler; replace GPU execution at the pass boundary.
const mocks = vi.hoisted(() => {
  class Pass {
    static all = new Map<string, Pass[]>();
    static instances = {
      get(label: string) {
        const passes = Pass.all.get(label) ?? [];
        return passes.reduce((latest, pass) =>
          (pass.createPass.mock.invocationCallOrder.at(-1) ?? 0) >
          (latest.createPass.mock.invocationCallOrder.at(-1) ?? 0) ? pass : latest, passes[0]);
      }
    };
    texture = { width: 80, height: 64, format: 'rgba8unorm' };
    constructor(label = '') { const list = Pass.all.get(label) ?? []; list.push(this); Pass.all.set(label, list); }
    outputs = new Map<string, Pass['texture']>();
    getMemoryBytes() { return 0; }
    setSize(width: number, height: number) {
      if (width === this.texture.width && height === this.texture.height) return;
      this.texture = { ...this.texture, width, height };
      this.outputs.clear();
    }
    reserveCapacity() {}
    retainOutput() {}
    releaseOutput() {}
    setUniform = vi.fn();
    setOutputParams() {}
    setRenderToScreen = vi.fn();
    getOutput(label = 'color') {
      if (!this.outputs.has(label)) this.outputs.set(label, { ...this.texture });
      return this.outputs.get(label)!;
    }
    createPass = vi.fn();
    dispose() {}
  }
  class TracePass extends Pass {
    static latest: TracePass;
    constructor() { super(); TracePass.latest = this; }
    prepareAovs() { return true; }
    renderAovs() { return true; }
    setSampleSequenceOffset = vi.fn();
    setSampleCount = vi.fn();
    setCamera() {}
    cameraChanged() { return false; }
    setJitter() {}
    setSampleTiles() {}
    getDiagnostics() { return {}; }
    getTargetMemoryBytes() { return 0; }
    releaseTarget() {}
    setTransmissiveOutputAlphaMin() {}
    useTarget() {}
    setQuality() {}
    updatePipeline() {}
    isCompilingShader() { return false; }
    isPipelineReady() { return true; }
    hasShadowCatcher() { return false; }
    needsDenoiseAlpha() { return false; }
    getOutputBuffer() { return {}; }
    setBounce() { return true; }
    setClamping() { return true; }
    setDirectLightCandidates() { return true; }
    setAlphaBlendStrategy() { return true; }
    setBevelSamples() { return true; }
    setSamplingPattern = vi.fn(() => true);
  }
  class OutputPass extends Pass {
    outputs = new Map<string, Pass['texture']>();
    getOutput(label = 'color') {
      if (!this.outputs.has(label)) this.outputs.set(label, { ...this.texture });
      return this.outputs.get(label)!;
    }
    setSampleCount() {}
    setSampleTileGrid() {}
  }
  return { Pass, TracePass, OutputPass };
});
vi.mock('../../src/renderer/WGPURayTracePass', () => ({ default: mocks.TracePass }));
vi.mock('../../src/renderer/WGPURayTraceOutput', () => ({ WGPURayTraceOutputPass: mocks.OutputPass }));
vi.mock('../../src/renderer/WGPUFullQuadPass', () => ({ WGPUFullQuadPass: mocks.Pass }));
vi.mock('../../src/renderer/WGPUComputePass', () => ({ WGPUComputePass: mocks.Pass }));

function createPipeline(timestamps = true, traceTimeNs: bigint | (() => bigint) = 1_000_000n, mapState: () => GPUBufferMapState = () => 'unmapped',causticTimeNs=0n) {
  const device = {
    features: new Set(timestamps ? ['timestamp-query'] : []),
    createQuerySet: (options:GPUQuerySetDescriptor) => ({ count: options.count, destroy() {} }),
    createBuffer: (opts: GPUBufferDescriptor) => ({
      size: opts.size, get mapState() {return mapState();}, destroy() {}, unmap() {},
      mapAsync: async () => {},
      getMappedRange: () => new BigInt64Array([
        0n, typeof traceTimeNs === 'function' ? traceTimeNs() : traceTimeNs,0n,causticTimeNs,0n,0n,0n,0n,0n,0n,0n,0n,0n,0n,0n,0n
      ]).buffer
    }),
    createTexture: (opts: GPUTextureDescriptor) => ({
      ...opts.size, format: opts.format, destroy: vi.fn()
    }),
    createSampler: () => ({}),
    createCommandEncoder: () => ({
      resolveQuerySet() {}, copyBufferToBuffer() {}, copyBufferToTexture() {},
      copyTextureToBuffer() {},
      copyTextureToTexture(source: {texture: object}, target: {texture: {copiedFrom?: object}}) {target.texture.copiedFrom = source.texture;}, finish() { return {}; }
    }),
    queue: { submit() {}, onSubmittedWorkDone: async () => {} }
  } as unknown as GPUDevice;
  const canvas = {
    getContext: () => ({ configure() {}, getCurrentTexture() { return {}; } })
  } as unknown as HTMLCanvasElement;
  const manager = makeWGPURenderTargets(canvas, device);
  const pipeline = manager.createTarget('test');
  pipeline.configure({bounces: 3, clamping: 0, bevel: true, bevelSamples: 8, directLightCandidates: 4, dispersionWavelengths: 3, alphaBlendStrategy: 'stochastic', samplingPattern: 'sobol', maxSamples: 2048, transmissiveOutputAlphaMin: 1, timeBudgetMs: 21, maxTiles: Infinity, batchSamples: false});
  pipeline.activate();
  pipeline.setSize(80, 64);
  return Object.assign(pipeline, {manager, device});
}

beforeEach(() => {
  mocks.Pass.all.clear();
  vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
  vi.stubGlobal('GPUBufferUsage', { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, COPY_DST: 2, COPY_SRC: 4 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('Image', class {
    src = '';
    set onload(callback: () => void) { callback(); }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function enableRealtime(pipeline: ReturnType<typeof createPipeline>, timeBudgetMs = 21) {
  pipeline.configure({bounces: 3, clamping: 0, bevel: true, bevelSamples: 8, directLightCandidates: 4, dispersionWavelengths: 3, alphaBlendStrategy: 'stochastic', samplingPattern: 'sobol', maxSamples: 2048, transmissiveOutputAlphaMin: 1, timeBudgetMs, maxTiles: Infinity, batchSamples: true});
}

async function warmRealtime(pipeline: ReturnType<typeof createPipeline>, camera: Camera) {
  pipeline.trace(camera, 128); await pipeline.flushDiagnostics();
  pipeline.trace(camera, 128); await pipeline.flushDiagnostics();
  enableRealtime(pipeline);
}

describe('WebGPU realtime sampling', () => {
  it('includes independent caustic timestamps in the frame budget',async()=>{
    vi.spyOn(performance,'now').mockReturnValue(0);
    const pipeline=createPipeline(true,1_000_000n,()=> 'unmapped',2_000_000n),camera=new Camera({projection:'perspective'});
    mocks.TracePass.latest.createPass.mockReturnValue(true);
    await warmRealtime(pipeline,camera);pipeline.trace(camera,128);await pipeline.flushDiagnostics();
    const timing=pipeline.getDiagnostics().gpuTraceTiming;
    expect(timing?.causticTimeMs).toBe(2);expect(timing?.estimatedFullFrameTimeMs).toBeGreaterThanOrEqual(3);
    pipeline.manager.dispose();
  });

  it('tops up only completed samples, preserves sequence indices and stops at the sample cap', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const pipeline = createPipeline(true, 2_000_000n), camera = new Camera({projection: 'perspective'});
    await warmRealtime(pipeline, camera);
    const completed: (() => void)[] = [];
    vi.spyOn(pipeline.device.queue, 'onSubmittedWorkDone').mockImplementation(() => new Promise(resolve => completed.push(() => resolve(undefined))));
    pipeline.trace(camera, 16); expect(pipeline.getTotalSamplesRendered()).toBe(11);
    pipeline.trace(camera, 16); expect(pipeline.getTotalSamplesRendered()).toBe(11);
    // Two samples retire while the other eight remain queued. Only two fit.
    completed.splice(0, 2).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 0));
    pipeline.trace(camera, 16); expect(pipeline.getTotalSamplesRendered()).toBe(13);
    completed.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 0));
    pipeline.trace(camera, 16); expect(pipeline.getTotalSamplesRendered()).toBe(16);
    // Discard the hidden timing probe's sample 0.
    expect(mocks.TracePass.latest.setSampleCount.mock.calls.slice(1).map(([sample]) => sample)).toEqual(Array.from({length: 16}, (_, i) => i));
    completed.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 0));
    pipeline.manager.dispose();
  });

  it('shares backpressure across resident targets and keeps previews unblocked', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const a = createPipeline(true, 2_000_000n), camera = new Camera({projection: 'perspective'});
    await warmRealtime(a, camera);
    const b = a.manager.createTarget('other');
    const settings = {bounces: 3, clamping: 0, bevel: true, bevelSamples: 8, directLightCandidates: 4, dispersionWavelengths: 3 as const, alphaBlendStrategy: 'stochastic' as const, samplingPattern: 'sobol' as const, maxSamples: 128, transmissiveOutputAlphaMin: 1, timeBudgetMs: 21, maxTiles: Infinity, batchSamples: false};
    b.configure(settings);
    b.setSize(80, 64); b.activate(); b.trace(camera, 128); await b.flushDiagnostics();
    b.trace(camera, 128); await b.flushDiagnostics();
    b.configure({...settings, batchSamples: true});
    const completed: (() => void)[] = [];
    vi.spyOn(a.device.queue, 'onSubmittedWorkDone').mockImplementation(() => new Promise(resolve => completed.push(() => resolve(undefined))));
    a.activate(); a.trace(camera, 128); expect(a.getTotalSamplesRendered()).toBe(11);
    b.activate(); b.trace(camera, 128); expect(b.getTotalSamplesRendered()).toBe(1);
    // A moving preview must enqueue its one sample even while final is full.
    b.configure({bounces: 3, clamping: 0, bevel: true, bevelSamples: 8, directLightCandidates: 4, dispersionWavelengths: 3, alphaBlendStrategy: 'stochastic', samplingPattern: 'sobol', maxSamples: 128, transmissiveOutputAlphaMin: 1, timeBudgetMs: 21, maxTiles: Infinity, batchSamples: false});
    b.restartSamples(); b.trace(camera, 128); expect(b.getTotalSamplesRendered()).toBe(1);
    completed.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 0));
    a.manager.dispose();
  });

  it('yields the main thread after four milliseconds of encoding', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const pipeline = createPipeline(), camera = new Camera({projection: 'perspective'});
    await warmRealtime(pipeline, camera);
    const pass = mocks.TracePass.latest;
    pass.createPass.mockImplementation(() => {now += 2;});
    pipeline.trace(camera, 128);
    expect(pipeline.getTotalSamplesRendered()).toBe(3);
    await pipeline.flushDiagnostics(); pipeline.manager.dispose();
  });

  it('resolves samples traced between frames once, at the next presentation or read', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const pipeline = createPipeline(true, 2_000_000n), camera = new Camera({projection: 'perspective'});
    await warmRealtime(pipeline, camera);
    const resolved = vi.spyOn(mocks.OutputPass.prototype, 'setSampleCount');
    pipeline.setRealtimeDeferPostProcess!(true); pipeline.trace(camera, 128);
    const first = pipeline.getTotalSamplesRendered(); expect(resolved).not.toHaveBeenCalled();
    pipeline.getOutputTexture!('hdr'); pipeline.getOutputTexture!('hdr');
    expect(resolved.mock.calls).toEqual([[first]]);
    await pipeline.flushDiagnostics(); pipeline.trace(camera, 128);
    const second = pipeline.getTotalSamplesRendered(); expect(second).toBeGreaterThan(first);
    pipeline.setRealtimeDeferPostProcess!(false); pipeline.drawPostProcess(); pipeline.drawPostProcess();
    expect(resolved.mock.calls).toEqual([[first], [second]]);
    await pipeline.flushDiagnostics(); pipeline.manager.dispose();
  });

  it('refreshes bloom after every ten new samples, also when several resolve together', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const bloom = vi.spyOn(WGPUBloomPass.prototype, 'createPass').mockImplementation((_encoder, color) => color);
    vi.spyOn(WGPUBloomPass.prototype, 'reserveCapacity').mockImplementation(() => {});
    const pipeline = createPipeline(true, 2_000_000n), camera = new Camera({projection: 'perspective'});
    await warmRealtime(pipeline, camera);
    pipeline.setBloomParams({intensity: 1, threshold: 1, radius: .6});
    pipeline.setRealtimeDeferPostProcess!(true);
    const refreshes: number[] = [];
    for (let frame = 0; frame < 4; frame++) {
      pipeline.trace(camera, 128); await pipeline.flushDiagnostics();
      const before = bloom.mock.calls.length; pipeline.drawPostProcess();
      if (bloom.mock.calls.length > before) refreshes.push(pipeline.getTotalSamplesRendered());
    }
    // No resolved count is a multiple of ten.
    expect(refreshes).toEqual([11, 21, 31, 41]);
    pipeline.manager.dispose();
  });

  it.each([false, true])('keeps single-sample stepping without a fast GPU measurement (timestamps=%s)', async timestamps => {
    const pipeline = createPipeline(timestamps, 30_000_000n), camera = new Camera({projection: 'perspective'});
    await warmRealtime(pipeline, camera);
    const before = pipeline.getTotalSamplesRendered(); pipeline.trace(camera, 128);
    expect(pipeline.getTotalSamplesRendered()).toBe(before + 1);
    await pipeline.flushDiagnostics(); pipeline.manager.dispose();
  });
});

describe('WebGPU offline sampling', () => {
  it.each([true, false])('submits only samples 0..7 after offline settings change (timestamps=%s)', async (timestamps) => {
    const pipeline = createPipeline(timestamps);
    pipeline.setOfflineRenderOptions({ samplesPerBatch: 4, deferPostProcess: true, sampleSequenceOffset: 0 });
    pipeline.restartSamples();
    // Renderer applies these after configuring the offline batch on its first render.
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 8); pipeline.present();
    expect(pipeline.getTotalSamplesRendered()).toBe(4);
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 8); pipeline.present();
    expect(pipeline.getTotalSamplesRendered()).toBe(8);
    expect(mocks.TracePass.latest.setSampleCount.mock.calls.map(([sample]) => sample)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await pipeline.flushDiagnostics();
    pipeline.dispose();
  });

  it('keeps the realtime timing probe and re-enables it after returning from offline mode', async () => {
    const pipeline = createPipeline();
    pipeline.setOfflineRenderOptions({ samplesPerBatch: 4, deferPostProcess: true, sampleSequenceOffset: 0 });
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 8); pipeline.present();
    expect(pipeline.getTotalSamplesRendered()).toBe(4);
    await pipeline.flushDiagnostics();
    pipeline.setOfflineRenderOptions({ samplesPerBatch: 0, deferPostProcess: false, sampleSequenceOffset: 0 });
    pipeline.restartSamples();
    mocks.TracePass.latest.setSampleCount.mockClear();
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 8); pipeline.present();
    expect(pipeline.getTotalSamplesRendered()).toBe(0);
    await pipeline.flushDiagnostics();
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 8); pipeline.present();
    expect(pipeline.getTotalSamplesRendered()).toBe(1);
    expect(mocks.TracePass.latest.setSampleCount.mock.calls.map(([sample]) => sample)).toEqual([0, 0]);
    await pipeline.flushDiagnostics();
    pipeline.dispose();
  });
});

it('restarts accumulation after changing the sampling pattern', () => {
  const pipeline = createPipeline(false);
  const camera = new Camera({projection: 'perspective', fov: 45, aspect: 1, near: 0.1, far: 100});
  pipeline.setOfflineRenderOptions({samplesPerBatch:4,deferPostProcess:true,sampleSequenceOffset:0});
  pipeline.activate(); pipeline.trace(camera,4); pipeline.present();
  expect(pipeline.getTotalSamplesRendered()).toBe(4);
  const trace=mocks.TracePass.latest;
  trace.setSampleCount.mockClear();
  pipeline.configure({bounces: 3, clamping: 0, bevel: true, bevelSamples: 8, directLightCandidates: 4, dispersionWavelengths: 3, alphaBlendStrategy: 'stochastic', samplingPattern: 'zsobol', maxSamples: 4, transmissiveOutputAlphaMin: 1, timeBudgetMs: 21, maxTiles: Infinity, batchSamples: false}); pipeline.activate(); pipeline.restartSamples();
  pipeline.activate(); pipeline.trace(camera,4); pipeline.present();
  expect(trace.setSampleCount.mock.calls.map(([value])=>value)).toEqual([0,1,2,3]);
});

function completedDenoiser(): OIDNWeb {
  return {
    tileExecute(opts: Parameters<OIDNWeb['tileExecute']>[0]) {
      const image = {
        data: { size: opts.color.width * opts.color.height * 16 } as GPUBuffer,
        width: opts.color.width, height: opts.color.height
      };
      opts.progress?.(image, undefined,
        { x: 0, y: 0, width: image.width, height: image.height }, 0, 1);
      opts.done(image);
      return () => {};
    }
  };
}

function displayedTexture() {
  const texture = mocks.Pass.instances.get('output')!.createPass.mock.lastCall![1].colorTex; return texture.copiedFrom ?? texture;
}

async function denoisedPipeline() {
  const pipeline = createPipeline(false);
  pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
  await pipeline.performDenoise!({kind: 'oidn', denoiser: completedDenoiser()}, undefined, 'progressive'); pipeline.present();
  return pipeline;
}

describe('WebGPU denoised presentation transitions', () => {
  it('denoises the whole composition once and keeps raw coverage for presentation', async () => {
    const pipeline = createPipeline(false);
    vi.spyOn(mocks.TracePass.latest, 'hasShadowCatcher').mockReturnValue(true);
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
    const compose = mocks.Pass.instances.get('compose')!;
    const rawInputs = compose.createPass.mock.lastCall![1];
    const denoiser = completedDenoiser();
    const execute = vi.spyOn(denoiser, 'tileExecute');
    await pipeline.performDenoise!({kind: 'oidn', denoiser}, undefined, 'progressive');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(compose.createPass.mock.lastCall![1]).toEqual(rawInputs);
    expect(execute.mock.lastCall![0].color.data).toMatchObject({size: 80 * 64 * 16});
    // Beauty contains the backdrop texture seen through the invisible catcher;
    // its albedo must describe that same composition, not a white receiver.
    const albedoCopy = mocks.Pass.instances.get('OIDN raw albedo copy')!;
    expect(albedoCopy.createPass.mock.lastCall![1].guide.texture).toBe(compose.getOutput('denoiseAlbedo'));
    const finish = mocks.Pass.instances.get('OIDN composed display')!;
    expect(finish.createPass.mock.lastCall![1].composedTex).toBe(compose.getOutput('denoiseColor'));
    pipeline.present();
    expect(displayedTexture()).toBe(finish.getOutput('color'));
    pipeline.dispose();
  });

  it('retains the explicitly configured alpha denoiser after composite RGB denoising', async () => {
    const pipeline = createPipeline(false);
    vi.spyOn(mocks.TracePass.latest, 'needsDenoiseAlpha').mockReturnValue(true);
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
    const alpha = completedDenoiser();
    const execute = vi.spyOn(alpha, 'tileExecute');
    await pipeline.performDenoise!({kind: 'oidn', denoiser: completedDenoiser()}, alpha);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.lastCall![0]).toMatchObject({
      color: {data: expect.objectContaining({size: 80 * 64 * 16})},
      denoiseAlpha: true
    });
    pipeline.dispose();
  });

  it('prefilters the composed albedo for clean-aux OIDN networks', async () => {
    const pipeline = createPipeline(false);
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
    const denoiser = {...completedDenoiser(), auxiliaryDenoisers: {
      albedo: completedDenoiser(), normal: completedDenoiser()
    }};
    await pipeline.performDenoise!({kind: 'oidn', denoiser}, undefined);
    const albedo = mocks.Pass.instances.get('compose')!.getOutput('denoiseAlbedo');
    expect(mocks.Pass.instances.get('OIDN albedo sRGB encode')!.createPass.mock.lastCall![1].albedo.texture).toBe(albedo);
    expect(mocks.Pass.instances.get('OIDN albedo sRGB decode')!.createPass.mock.lastCall![1].rawAlbedo.texture).toBe(albedo);
    pipeline.dispose();
  });

  it.each(['standard', 'albedo', 'normal', 'beauty'] as const)('discards cancelled first-inference results during %s filtering', async stage => {
    const pipeline = createPipeline(false);
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
    const abort = vi.fn();
    let options!: Parameters<OIDNWeb['tileExecute']>[0];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const held: OIDNWeb = {tileExecute(opts) {options = opts; started(); return abort;}};
    const beauty = stage === 'beauty' || stage === 'standard' ? held : completedDenoiser();
    const execute = vi.spyOn(beauty, 'tileExecute');
    const auxiliaryDenoisers = stage === 'standard' ? undefined : {
      albedo: stage === 'albedo' ? held : completedDenoiser(),
      normal: stage === 'normal' ? held : completedDenoiser()
    };
    const pending = pipeline.performDenoise!({kind: 'oidn', denoiser: {...beauty, auxiliaryDenoisers}}, undefined);
    await ready;
    // Display._configure invalidates the target before changing compose uniforms.
    pipeline.invalidateDenoisedOutput();
    pipeline.setToneMappingParams({exposure: 2});
    pipeline.drawPostProcess(); pipeline.present();
    const displayed = displayedTexture();
    const decode = mocks.Pass.instances.get('OIDN albedo sRGB decode')!;
    const decodeCalls = decode.createPass.mock.calls.length;
    const beautyCalls = execute.mock.calls.length;
    expect(abort).toHaveBeenCalledOnce();
    expect(await pending).toBe(false);
    // An executor may still deliver callbacks after its abort function returns.
    const image = {data: {size: 80 * 64 * 16} as GPUBuffer, width: 80, height: 64};
    options.progress?.(image, undefined, {x: 0, y: 0, width: 80, height: 64}, 0, 1);
    options.done(image);
    await Promise.resolve();
    pipeline.present();
    expect(displayedTexture()).toBe(displayed);
    expect(decode.createPass).toHaveBeenCalledTimes(decodeCalls);
    expect(execute).toHaveBeenCalledTimes(beautyCalls);
    expect(pipeline.getTotalSamplesRendered()).toBe(1);
    pipeline.manager.dispose();
  });

  it('publishes a completed composite when OIDN omits progress callbacks', async () => {
    const pipeline = createPipeline(false);
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
    await pipeline.performDenoise!({kind: 'oidn', denoiser: { tileExecute(opts: Parameters<OIDNWeb['tileExecute']>[0]) {
      opts.done({ data: { size: 80 * 64 * 16 } as GPUBuffer, width: 80, height: 64 });
      return () => {};
    } }}, undefined);
    pipeline.present();
    expect(displayedTexture()).toBe(mocks.Pass.instances.get('OIDN composed display')!.getOutput('color'));
    pipeline.dispose();
  });

  it('invalidates composed denoising when exposure changes without restarting samples', async () => {
    const pipeline = await denoisedPipeline();
    expect(pipeline.setToneMappingParams({ exposure: 2 })).toBe(true);
    pipeline.drawPostProcess(); pipeline.present();
    expect(displayedTexture()).toBe(mocks.Pass.instances.get('compose')!.getOutput('color'));
    expect(pipeline.getTotalSamplesRendered()).toBe(1);
    pipeline.dispose();
  });

  it('immediately restores a resized canvas from the completed presentation', async () => {
    const pipeline = await denoisedPipeline();
    pipeline.present();
    const completedTexture = displayedTexture();
    pipeline.setSize(160, 96); pipeline.present();
    const snapshot = displayedTexture();
    expect(snapshot).toBe(completedTexture);
    expect(snapshot).toMatchObject({ width: 80, height: 64 });
    expect(mocks.Pass.instances.get('output')!.setRenderToScreen).toHaveBeenCalled();
    pipeline.drawPostProcess();
    expect(displayedTexture()).toBe(snapshot);
    pipeline.dispose();
  });

  it('cancels an in-flight denoise on resize without losing the completed image', async () => {
    const pipeline = await denoisedPipeline();
    const abort = vi.fn();
    let options: Parameters<OIDNWeb['tileExecute']>[0];
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = pipeline.performDenoise!({kind: 'oidn', denoiser: {
      tileExecute(opts: Parameters<OIDNWeb['tileExecute']>[0]) {
        options = opts;
        started();
        return abort;
      }
    }}, undefined, 'progressive');
    await ready;
    pipeline.setSize(160, 96); pipeline.present();
    const snapshot = displayedTexture();
    expect(snapshot).toMatchObject({ width: 80, height: 64 });
    expect(abort).toHaveBeenCalledOnce();
    expect(await pending).toBe(false);
    options!.progress?.({ data: {} as GPUBuffer, width: 80, height: 64 },
      undefined, { x: 0, y: 0, width: 80, height: 64 }, 0, 1);
    expect(displayedTexture()).toBe(snapshot);
    pipeline.dispose();
  });

  it('stops holding the previous denoise when denoising is disabled or samples restart', async () => {
    const pipeline = await denoisedPipeline();
    pipeline.setSize(160, 96); pipeline.present();
    const snapshot = displayedTexture();
    pipeline.restartSamples();
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
    expect(displayedTexture()).not.toBe(snapshot);
    await pipeline.performDenoise!({kind: 'oidn', denoiser: completedDenoiser()}, undefined, 'progressive');
    pipeline.setSize(240, 128); pipeline.present();
    const nextSnapshot = displayedTexture();
    pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.present();
    expect(displayedTexture()).not.toBe(nextSnapshot);
    pipeline.dispose();
  });
});


it('retires an AOV presentation selection before tracing with AOVs disabled', () => {
  const pipeline = createPipeline(false);
  pipeline.setOutput('depth');
  pipeline.configure({bounces: 3, clamping: 0, bevel: true, bevelSamples: 8, directLightCandidates: 4, dispersionWavelengths: 3, alphaBlendStrategy: 'stochastic', samplingPattern: 'sobol', maxSamples: 2048, transmissiveOutputAlphaMin: 1, timeBudgetMs: 21, maxTiles: Infinity, batchSamples: false, aovs: []});
  expect(() => pipeline.trace(new Camera({projection: 'perspective'}), 1)).not.toThrow();
  pipeline.present();
  expect(displayedTexture()).toBe(mocks.Pass.instances.get('compose')!.getOutput('color'));
  pipeline.manager.dispose();
});

it('falls back to AgX for unknown tone mapping values', () => {
  const pipeline = createPipeline(false);
  pipeline.setToneMappingParams({ toneMapping: 'aces' });
  const compose = mocks.Pass.instances.get('compose')!;
  compose.setUniform.mockClear();
  pipeline.setToneMappingParams({ toneMapping: 'removed-mode' as never });
  expect(compose.setUniform).toHaveBeenCalledWith('toneMappingParams', [0, 0]);
  pipeline.dispose();
});

it('completes samples during continuous input restarts after the initial timing probe', async () => {
  const pipeline = createPipeline(); const camera = new Camera({projection: 'perspective'});
  pipeline.activate(); pipeline.trace(camera, 1); expect(pipeline.getTotalSamplesRendered()).toBe(0);
  await pipeline.flushDiagnostics();
  const sample = vi.fn(); pipeline.setOnSampleRendered(sample);
  for (let frame = 0; frame < 4; frame++) {
    camera.position = [frame, 0, 0]; pipeline.restartSamples(); pipeline.activate(); pipeline.trace(camera, 1);
    expect(pipeline.getTotalSamplesRendered()).toBe(1); await pipeline.flushDiagnostics();
  }
  expect(sample).toHaveBeenCalledTimes(4); pipeline.dispose();
});
it.each(['pending', 'mapped'] as const)('keeps visible samples when the shared timing readback starts %s', async initialState => {
  let state: GPUBufferMapState = initialState;
  const pipeline = createPipeline(true, 1_000_000n, () => state); const camera = new Camera({projection: 'perspective'});
  pipeline.trace(camera, 64); expect(pipeline.getTotalSamplesRendered()).toBe(1);
  state = 'unmapped';
  for (let sample = 2; sample <= 4; sample++) {
    pipeline.trace(camera, 64); expect(pipeline.getTotalSamplesRendered()).toBe(sample);
    await pipeline.flushDiagnostics();
  }
  pipeline.manager.dispose();
});
it('refreshes the hidden timing probe for structural scene changes', async () => {
  const pipeline = createPipeline(); const camera = new Camera({projection: 'perspective'});
  pipeline.trace(camera, 1); await pipeline.flushDiagnostics(); pipeline.trace(camera, 1); expect(pipeline.getTotalSamplesRendered()).toBe(1); await pipeline.flushDiagnostics();
  pipeline.invalidateTiming!(); pipeline.restartSamples(); pipeline.trace(camera, 1); expect(pipeline.getTotalSamplesRendered()).toBe(0);
  await pipeline.flushDiagnostics(); pipeline.restartSamples(); pipeline.trace(camera, 1); expect(pipeline.getTotalSamplesRendered()).toBe(1); await pipeline.flushDiagnostics(); pipeline.dispose();
});

it('supplies HDR buffers to a custom filter and applies display settings after it', async () => {
  const pipeline = createPipeline(false);
  pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1);
  pipeline.setToneMappingParams({exposure: 2}); pipeline.drawPostProcess();
  const raw = mocks.Pass.instances.get('compose')!.createPass.mock.lastCall![1].colorTex;
  const denoise = vi.fn(async (_input: import('../../src/Render').DenoiseInput) => {});
  await pipeline.performDenoise!({kind: 'custom', denoiser: {denoise}}, undefined, 'every-sample');
  const input = denoise.mock.calls[0][0];
  expect(input).toMatchObject({width: 80, height: 64, color: {size: 80 * 64 * 16}, albedo: {size: 80 * 64 * 16}, normal: {size: 80 * 64 * 16}, output: {size: 80 * 64 * 16}});
  expect(mocks.Pass.instances.get('Custom HDR input copy')!.createPass.mock.lastCall![1].guide.texture).toBe(raw);
  const compose = mocks.Pass.instances.get('compose')!;
  expect(compose.createPass.mock.lastCall![1].colorTex).not.toBe(raw);
  expect(compose.setUniform).toHaveBeenCalledWith('exposure', 2);
  expect(compose.setUniform).toHaveBeenLastCalledWith('bloomIntensity', 0);
  pipeline.present(); expect(displayedTexture()).toBe(compose.getOutput('color')); pipeline.manager.dispose();
});

it('aborts custom inference on resize without publishing a late result', async () => {
  const pipeline = createPipeline(false); pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.drawPostProcess();
  let finish!: () => void; let signal!: AbortSignal;
  const pending = pipeline.performDenoise!({kind: 'custom', denoiser: {denoise(_input, context) {
    signal = context.signal; return new Promise(resolve => {finish = resolve;});
  }}});
  expect(signal.aborted).toBe(false); pipeline.setSize(160, 96); expect(signal.aborted).toBe(true);
  finish(); expect(await pending).toBe(false); expect(pipeline.presentationDenoised).toBe(false);
  expect(mocks.Pass.instances.get('Custom coverage')).toBeUndefined(); pipeline.manager.dispose();
});

it('keeps borrowed scratch resources alive until a cancelled custom promise settles', async () => {
  const pipeline = createPipeline(false); pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.drawPostProcess();
  let finish!: () => void; let signal!: AbortSignal;
  const pending = pipeline.performDenoise!({kind: 'custom', denoiser: {denoise(_input, context) {
    signal = context.signal; return new Promise(resolve => {finish = resolve;});
  }}});
  const scratchPass = mocks.Pass.instances.get('Custom HDR input copy')!;
  const release = vi.spyOn(scratchPass, 'dispose'); pipeline.manager.dispose();
  await Promise.resolve(); await Promise.resolve(); expect(signal.aborted).toBe(true); expect(release).not.toHaveBeenCalled();
  finish(); expect(await pending).toBe(false); await new Promise(resolve => setTimeout(resolve, 0));
  expect(release).toHaveBeenCalledOnce();
});

it('keeps borrowed scratch alive when custom denoise disposes synchronously', async () => {
  const pipeline = createPipeline(false); pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.drawPostProcess();
  let finish!: () => void;
  let released = false;
  let signal!: AbortSignal;
  const pending = pipeline.performDenoise!({kind: 'custom', denoiser: {denoise(_input, context) {
    signal = context.signal;
    vi.spyOn(mocks.Pass.instances.get('Custom HDR input copy')!, 'dispose').mockImplementation(() => {released = true;});
    pipeline.manager.dispose();
    return new Promise(resolve => {finish = resolve;});
  }}});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(signal.aborted).toBe(true);
  expect(released).toBe(false);
  finish(); expect(await pending).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 0)); expect(released).toBe(true);
});

it('keeps flat background and catcher composition on the ordinary display path for custom HDR', async () => {
  const pipeline = createPipeline(false);
  vi.spyOn(mocks.TracePass.latest, 'hasShadowCatcher').mockReturnValue(true);
  pipeline.synchronizeBackground([1, 1, 1, 1]);
  pipeline.setShadowCatcherParams([.1, .2, .3], .4);
  pipeline.activate(); pipeline.trace(new Camera({projection: 'perspective'}), 1); pipeline.drawPostProcess();
  const compose = mocks.Pass.instances.get('compose')!;
  const original = compose.createPass.mock.lastCall![1];
  await pipeline.performDenoise!({kind: 'custom', denoiser: {denoise: async () => {}}});
  const layers = mocks.Pass.instances.get('Custom HDR layers')!;
  expect(layers.createPass.mock.lastCall![1]).toMatchObject({originalTex: original.colorTex,
    foregroundTex: original.foregroundTex, backgroundTex: original.catcherBackgroundTex});
  expect(compose.createPass.mock.lastCall![1]).toMatchObject({foregroundTex: layers.getOutput('foreground'),
    catcherBackgroundTex: layers.getOutput('background'), shadowCatcherTex: original.shadowCatcherTex});
  expect(compose.setUniform).toHaveBeenCalledWith('flatBackgroundColor', [1, 1, 1, 1]);
  expect(compose.setUniform).toHaveBeenCalledWith('shadowCatcherEnabled', 1);
  expect(compose.setUniform).toHaveBeenCalledWith('shadowCatcherAlpha', .4);
  pipeline.manager.dispose();
});


it.each(['normal', 'albedo', 'shadowCatcher', 'depth'] as const)('keeps %s diagnostic output free of color inference', async output => {
  const pipeline = createPipeline(false);
  if (output === 'depth') pipeline.configure({bounces: 3, clamping: 0, bevel: true, bevelSamples: 8, directLightCandidates: 4, dispersionWavelengths: 3, alphaBlendStrategy: 'stochastic', samplingPattern: 'sobol', maxSamples: 2048, transmissiveOutputAlphaMin: 1, timeBudgetMs: 21, maxTiles: Infinity, batchSamples: false, aovs: ['depth']});
  pipeline.trace(new Camera({projection: 'perspective'}), 1);
  pipeline.setOutput(output);
  const denoiser = completedDenoiser(), execute = vi.spyOn(denoiser, 'tileExecute');
  await pipeline.performDenoise!({kind:'oidn',denoiser},undefined).catch(()=>false);
  expect(execute).not.toHaveBeenCalled();
  pipeline.dispose();
});

it.each([false,true])('records actual composition after bloom (%s)', async bloom => {
  const pipeline=createPipeline(false);
  pipeline.setOfflineRenderOptions({samplesPerBatch:32,deferPostProcess:false,sampleSequenceOffset:19});
  pipeline.setBloomParams({intensity:bloom?.2:0,threshold:1,radius:.6});
  const events:string[]=[];
  vi.spyOn(WGPUBloomPass.prototype,'createPass').mockImplementation(()=>{events.push('Bloom:SceneLinear');return {} as GPUTexture;});
  const compose=mocks.Pass.instances.get('compose')!;
  compose.createPass.mockImplementation(()=>{events.push('Compose:DisplayEncoded');});
  pipeline.trace(new Camera({projection:'perspective'}),32);
  const table=JSON.parse((await import('node:fs')).readFileSync(new URL('../fixtures/display-order.json',import.meta.url),'utf8'));
  expect(events).toEqual(table.cases.find((row:{name:string})=>row.name===(bloom?'sdr-bloom':'sdr-raw')).trace);
  pipeline.dispose();
});

it('keeps internal WebGPU fixture methods out of Engine diagnostics', () => {
  const target = createPipeline();
  const engine = new Engine({canvas: {width: 80, height: 64} as HTMLCanvasElement});
  Object.assign(engine, {_pipeline: target.manager, _info: {backend: 'webgpu'}, _gpuDevice: target.device});
  expectDataOnlyDiagnostics(engine.getDiagnostics());
  engine.dispose();
});
