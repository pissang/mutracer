/// <reference types="@webgpu/types" preserve="true" />

import Engine from './Engine.js';
import type {DisplaySettings, PostProcess} from './Display.js';
import Render, {type Denoiser} from './Render.js';
import type {OIDNFilterOptions} from './oidnOptions.js';
import {mat4} from './math.js';
import {cameraApertureRadius} from './renderer/cameraLens.js';
import {TemporalGPU} from './renderer/WGPUTemporalHistory.js';
import {DirectWindowGPU} from './renderer/WGPUTemporalWindow.js';
import {createSparklePost} from './renderer/WGPUTemporalSparkle.js';
import {createOIDNFilter, type OIDNFilter} from './oidn.js';
import {historyNeighbors, readyThrough, temporalLatency} from './temporal/schedule.js';
import {normalizeTemporalOptions, type NormalizedTemporalOptions} from './temporal/options.js';
export type {TemporalDenoiserOptions, TemporalHistoryRadius, TemporalMode, TemporalSpatialDenoiser} from './temporal/options.js';

const CAPTURE_AOVS = ['centerPosition', 'centerDepth', 'centerNormal', 'roughness', 'motion', 'id'] as const;
const MAX_FINISHED = 4;
const mergeWindowWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read> window: array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&output)) { return; }
  output[g.x] = vec4f(window[g.x].rgb, output[g.x].a);
}`;
const composePackWGSL = /* wgsl */ `
struct Frame { size: vec2u, slot: u32, samples: u32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage,read> accumulated: array<vec4f>;
@group(0) @binding(2) var guides: texture_2d_array<f32>;
@group(0) @binding(3) var raw: texture_2d_array<f32>;
struct Overflow { index: atomic<u32>, color: vec4f }
@group(0) @binding(4) var<storage,read_write> overflow: array<Overflow>;
@group(0) @binding(5) var<storage,read_write> color: array<vec4f>;
@group(0) @binding(6) var<storage,read_write> albedo: array<vec4f>;
@group(0) @binding(7) var<storage,read_write> normal: array<vec4f>;
fn rawColor(at:vec2i)->vec4f{
  let value=textureLoad(raw,at,i32(frame.slot),0); if(value.a!=-1.){return value;}
  let key=u32(at.y)*frame.size.x+u32(at.x)+1u;
  for(var probe=0u;probe<4096u;probe++){
    let address=frame.slot*4096u+((key*2654435761u+probe)&4095u);let found=atomicLoad(&overflow[address].index);
    if(found==key){return overflow[address].color;} if(found==0u){break;}
  }
  return vec4f(0);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=frame.size)) {return;}
  let at=vec2i(g.xy); let rgba=accumulated[g.y*frame.size.x+g.x];
  let alb=textureLoad(guides,at,i32(frame.slot*2u),0); let nrm=textureLoad(guides,at,i32(frame.slot*2u+1u),0);
  let n=f32(frame.samples); let hit=floor(alb.a*n+0.5); let dst=(frame.size.y-1-g.y)*frame.size.x+g.x;
  color[dst]=vec4f(rgba.rgb*select(n,hit,hit>0.0),rawColor(at).a*n);
  albedo[dst]=vec4f(alb.rgb*n,hit);
  normal[dst]=vec4f(select(vec3f(0),(nrm.rgb-0.5)*2.0*n,nrm.a>0.0),n);
}`;

export type TemporalPixelKind = 'denoised' | 'accumulated';
export interface TemporalPlan {
  readonly historyRadius: Readonly<{min: number; max: number}>;
  readonly postRadius: number;
  readonly bytes: number;
}

function copyBuffer(device: GPUDevice, source: GPUBuffer, bytes: number, label: string) {
  const target = device.createBuffer({label, size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
  const encoder = device.createCommandEncoder({label});
  encoder.copyBufferToBuffer(source, 0, target, 0, bytes);
  device.queue.submit([encoder.finish()]);
  return target;
}

/** A borrowed finished animation frame. It remains valid until its drain/flush iterator advances. */
export class TemporalFrame {
  /** Push index within this denoiser, starting at zero. */
  readonly index!: number;
  /** Frame width in pixels. */
  readonly width!: number;
  /** Frame height in pixels. */
  readonly height!: number;
  /** @internal */ readonly _temporalFrame = true;
  private buffers!: Record<TemporalPixelKind, GPUBuffer>;
  private device!: GPUDevice;
  private presentation!: Render;
  private presentationPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private valid = true;

  /** @internal */
  constructor(device: GPUDevice, presentation: Render, index: number, width: number, height: number, buffers: Record<TemporalPixelKind, GPUBuffer>) {
    Object.assign(this, {device, presentation, index, width, height, buffers});
  }

  /** Reads RGBA float32 pixels. Default `'denoised'`. */
  async readPixels(kind: TemporalPixelKind = 'denoised') {
    if (!this.valid) throw new Error('This temporal frame is no longer borrowed.');
    if (kind !== 'denoised' && kind !== 'accumulated') throw new Error(`Unknown temporal pixel kind ${kind}.`);
    const bytes = this.width * this.height * 16;
    const staging = this.device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const encoder = this.device.createCommandEncoder({label: 'Temporal frame readback'});
      encoder.copyBufferToBuffer(this.buffers[kind], 0, staging, 0, bytes);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      return {width: this.width, height: this.height, data: new Float32Array(staging.getMappedRange().slice(0))};
    } finally { staging.destroy(); }
  }

  /** @internal */ _buffer(kind: TemporalPixelKind) {
    if (!this.valid) throw new Error('This temporal frame is no longer borrowed.');
    return this.buffers[kind];
  }
  /** @internal */ _withPresentation<T>(callback: (render: Render) => T): T {
    if (!this.valid) throw new Error('This temporal frame is no longer borrowed.');
    const pass: PostProcess = ({device, encoder, output}) => {
      let pipeline = this.presentationPipelines.get(output.format);
      if (!pipeline) {
        const vertex = device.createShaderModule({code:'@vertex fn main(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4f(x*2.-1.,y*2.-1.,0.,1.);}'});
        const fragment = device.createShaderModule({code:`@group(0) @binding(0) var<storage,read> pixels:array<vec4f>;
          @fragment fn main(@builtin(position) p:vec4f)->@location(0) vec4f {let i=u32(p.y)*${this.width}u+u32(p.x);return vec4f(floor(clamp(pixels[i].rgb,vec3f(0),vec3f(255))+.5)/255.,1.);}`});
        pipeline = device.createRenderPipeline({layout:'auto',vertex:{module:vertex,entryPoint:'main'},fragment:{module:fragment,entryPoint:'main',targets:[{format:output.format}]},primitive:{topology:'triangle-list'}});
        this.presentationPipelines.set(output.format,pipeline);
      }
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.buffers.denoised}}]});
      const renderPass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store'}]});
      renderPass.setPipeline(pipeline);renderPass.setBindGroup(0,group);renderPass.draw(3);renderPass.end();
    };
    const remove=this.presentation.engine.display.addPostProcess(pass);
    try { const result=callback(this.presentation); if (result instanceof Promise) return result.finally(remove) as T; remove(); return result; }
    catch (error) { remove(); throw error; }
  }
  /** @internal */ _release() {
    if (!this.valid) return;
    this.valid = false;
    this.buffers.denoised.destroy(); this.buffers.accumulated.destroy();
  }
}

/** GPU temporal history, spatial denoising and stabilisation for animation renders. */
export class TemporalDenoiser {
  /** Number of pushes before an output can become drainable. */
  readonly latency: number;
  private readonly options: NormalizedTemporalOptions;
  /** Effective allocation after budgeting; undefined until the first push. */
  plan?: TemporalPlan;
  private engine: Engine;
  private attached?: Render;
  private detachRender?: () => void;
  private history?: any;
  private window?: any;
  private post?: any;
  private sparkle?: Awaited<ReturnType<typeof createSparklePost>>;
  private oidn?: OIDNFilter;
  private frames = 0;
  private nextWindow = 0;
  private nextOutput = 0;
  private finished: TemporalFrame[] = [];
  private disposed = false;
  private flushing = false;
  private previousOffset?: number;
  private warnedOffset = false;
  private accumulated = new Map<number, GPUBuffer>();
  private spatialOutputs = new Map<number, GPUBuffer>();
  private epoch = 0;
  private epochs: number[] = [];
  private sampleCounts: number[] = [];
  private displaySettings: Required<DisplaySettings>[] = [];
  private customAovs = new Map<number, Partial<Record<import('./renderer/aov.js').AovKind, GPUBuffer>>>();
  private replay?: Render;
  private composePipeline?: GPUComputePipeline;
  private mergeWindowPipeline?: GPUComputePipeline;
  private composeParams?: GPUBuffer;
  private composeBuffers?: {color: GPUBuffer; albedo: GPUBuffer; normal: GPUBuffer};

  constructor(engine: Engine, options: import('./temporal/options.js').TemporalDenoiserOptions = {}) {
    this.engine = engine;
    this.options = normalizeTemporalOptions(options);
    this.latency = temporalLatency(this.options);
  }

  /** Attaches hidden capture AOVs to one render and returns a detach function. */
  attach(render: Render) {
    this.assertAlive();
    if (render.engine !== this.engine) throw new Error('Temporal denoiser and render must use the same engine.');
    if (this.attached && this.attached !== render) throw new Error('A temporal denoiser can attach to only one render at a time.');
    if (this.attached === render) throw new Error('This render is already attached.');
    if (render.denoiser) console.warn('The attached render has its own denoiser; temporal capture ignores that result.');
    this.attached = render;
    const custom = this.options.denoiser?.type === 'custom' ? this.options.denoiser.aovs ?? [] : [];
    const detach = render._attachTemporal([...new Set([...CAPTURE_AOVS, ...custom])] as any);
    this.detachRender = () => { if (this.attached !== render) return; detach(); this.attached = undefined; this.detachRender = undefined; };
    return this.detachRender;
  }

  /** Captures one converged frame. Resolves after its GPU capture has been submitted. */
  async push(render: Render) {
    this.assertAlive();
    if (this.flushing) throw new Error('Cannot push while flush is active.');
    await this.engine.init();
    if (this.engine.backend !== 'webgpu' || !this.engine.device) throw new Error('Temporal denoising requires WebGPU.');
    if (render !== this.attached) throw new Error('Temporal push requires the attached render.');
    if (!render.converged) throw new Error('Temporal push requires a converged render.');
    if (this.finished.length >= MAX_FINISHED) throw new Error('Too many finished temporal frames are waiting; drain output before pushing.');
    await this.ensureResources(render.width, render.height);
    if (render.width !== this.history.width || render.height !== this.history.height) throw new Error('Temporal frame dimensions changed within a shot.');
    const metadata = render._temporalMetadata;
    if (!metadata.camera) throw new Error('Temporal push requires a completed converge call.');
    if (!this.replay) {
      this.replay = new Render(this.engine, {width: render.width, height: render.height, maxSamples: 1});
      await this.replay.converge({samples: 1, camera: metadata.camera});
    }
    if (this.previousOffset === metadata.sampleSequenceOffset && !this.warnedOffset) {
      this.warnedOffset = true; console.warn('Consecutive temporal frames use the same sampleSequenceOffset; correlated noise will not average out.');
    }
    this.previousOffset = metadata.sampleSequenceOffset;
    const direct = metadata as typeof metadata & {projection?: number[]; viewProjection?: number[]; apertureRadius?: number; focusDistance?: number};
    const projection = direct.projection ?? metadata.camera.getProjectionMatrix(render.width / render.height);
    const view = mat4.create(); mat4.invert(view, metadata.camera.transform);
    const viewProjection = direct.viewProjection ?? mat4.mul(mat4.create(), projection, view);
    const frame = this.frames++;
    this.epochs[frame] = this.epoch;
    this.sampleCounts[frame] = metadata.samples;
    this.displaySettings[frame] = this.engine.display._snapshotSettings();
    await render._captureTemporal(async input => {
      const aovs = input.aovs!;
      this.window.capture(frame, {...input, ...aovs});
      await this.history.uploadBuffers(frame, {
        viewProjection, projection, apertureRadius: direct.apertureRadius ?? cameraApertureRadius(metadata.camera!),
        focusDistance: direct.focusDistance ?? metadata.camera!.focusDistance
      }, {...input, ...aovs});
      if (this.options.denoiser?.type === 'custom' && this.options.denoiser.aovs?.length) {
        const copies: Partial<Record<import('./renderer/aov.js').AovKind, GPUBuffer>> = {};
        const encoder = this.engine.device!.createCommandEncoder({label: 'Temporal custom denoiser AOV capture'});
        for (const kind of this.options.denoiser.aovs) {
          const source = aovs[kind];
          if (!source) throw new Error(`Temporal capture is missing custom denoiser AOV ${kind}.`);
          const copy = this.engine.device!.createBuffer({label: `Temporal custom ${kind} AOV`, size: source.size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          encoder.copyBufferToBuffer(source, 0, copy, 0, source.size); copies[kind] = copy;
        }
        this.engine.device!.queue.submit([encoder.finish()]); this.customAovs.set(frame, copies);
      }
    });
    await this.process(false);
  }

  /** Yields every currently finished frame in order. */
  async *drain(): AsyncGenerator<TemporalFrame> {
    this.assertAlive();
    while (this.finished.length) {
      const frame = this.finished.shift()!;
      try { yield frame; } finally { frame._release(); }
    }
  }

  /** Finishes the shot with truncated future windows, yields it, then resets history. */
  async *flush(): AsyncGenerator<TemporalFrame> {
    this.assertAlive(); this.flushing = true;
    try {
      while (this.finished.length || this.nextOutput < this.frames) {
        if (!this.finished.length) await this.process(true);
        if (!this.finished.length) throw new Error('Temporal flush made no progress.');
        yield* this.drain();
      }
      this.resetShot();
    } finally { this.flushing = false; }
  }

  /** Marks a history boundary before the next push. Pending output remains drainable. */
  cut() { this.assertAlive(); this.epoch++; }

  /** Releases GPU history and the spatial denoiser. Safe to repeat. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.detachRender?.();
    for (const frame of this.finished) frame._release(); this.finished.length = 0;
    for (const buffer of this.accumulated.values()) buffer.destroy(); this.accumulated.clear();
    for (const buffer of this.spatialOutputs.values()) buffer.destroy(); this.spatialOutputs.clear();
    for (const aovs of this.customAovs.values()) for (const buffer of Object.values(aovs)) buffer?.destroy(); this.customAovs.clear();
    this.sparkle?.dispose(); this.oidn?.dispose(); this.history?.dispose(); this.window?.dispose(); this.post?.dispose();
    this.replay?.dispose(); this.composeParams?.destroy();
    if (this.composeBuffers) for (const buffer of Object.values(this.composeBuffers)) buffer.destroy();
  }

  private assertAlive() { if (this.disposed) throw new Error('Temporal denoiser is disposed.'); }
  private async ensureResources(width: number, height: number) {
    if (this.history) return;
    const device = this.engine.device!;
    const historySlots = this.options.mode === 'offline' ? this.options.historyRadius.max * 2 + 1 : this.options.historyRadius.max + 1;
    this.history = await TemporalGPU.create(device, width, height, 'pre', historySlots);
    this.window = await DirectWindowGPU.create(device, width, height, historySlots,
      this.options.historyRadius.min !== this.options.historyRadius.max, this.options.stabilizeSparkle, 'veto');
    this.window.useHistory(this.history);
    this.post = await TemporalGPU.create(device, width, height, 'post', this.options.mode === 'offline' ? this.options.postRadius * 2 + 1 : this.options.postRadius + 1);
    if (this.options.stabilizeSparkle) this.sparkle = await createSparklePost(device);
    if (this.options.denoiser?.type === 'oidn') {
      const {type: _type, ...oidnOptions} = this.options.denoiser;
      this.oidn = await createOIDNFilter(this.engine, oidnOptions as OIDNFilterOptions);
    }
    const bytes = this.history.memory().total + this.window.memory().total + this.post.memory().total;
    const module = device.createShaderModule({label: 'Temporal composition pack', code: composePackWGSL});
    this.composePipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
    const mergeModule = device.createShaderModule({label: 'Temporal window merge', code: mergeWindowWGSL});
    this.mergeWindowPipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: mergeModule, entryPoint: 'main'}});
    this.composeParams = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    const imageBytes = width * height * 16, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.composeBuffers = {color: device.createBuffer({size: imageBytes, usage}), albedo: device.createBuffer({size: imageBytes, usage}), normal: device.createBuffer({size: imageBytes, usage})};
    this.plan = Object.freeze({historyRadius: this.options.historyRadius, postRadius: this.options.postRadius, bytes});
  }

  private async spatial(frame: number, accumulated: GPUBuffer) {
    const device = this.engine.device!, bytes = this.history.bytes;
    const output = device.createBuffer({label: 'Temporal spatial output', size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
    const guides = this.history.getGuides(frame);
    if (this.oidn) {
      const input = this.composeForOIDN(frame, accumulated);
      await this.oidn.denoise({width: this.history.width, height: this.history.height, ...input, output});
    }
    else if (this.options.denoiser?.type === 'custom') {
      const denoiser = this.options.denoiser.denoiser as Denoiser;
      await this.engine._prepareCustomDenoiser(denoiser, this.history.width, this.history.height);
      const controller = new AbortController();
      try {
        await denoiser.denoise({device, width: this.history.width, height: this.history.height,
          color: accumulated, albedo: guides.albedo, normal: guides.normal, output, aovs: this.customAovs.get(frame)},
          {signal: controller.signal, schedule: 'converged'});
      } finally {
        const aovs = this.customAovs.get(frame); if (aovs) { for (const buffer of Object.values(aovs)) buffer?.destroy(); this.customAovs.delete(frame); }
      }
    } else {
      const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(accumulated, 0, output, 0, bytes); device.queue.submit([encoder.finish()]);
    }
    return output;
  }

  private composeForOIDN(frame: number, accumulated: GPUBuffer) {
    const device = this.engine.device!, buffers = this.composeBuffers!;
    const samples = this.sampleCounts[frame];
    device.queue.writeBuffer(this.composeParams!, 0, new Uint32Array([this.history.width, this.history.height, this.history.slot(frame), samples]));
    const values = [this.composeParams!, accumulated, this.history.guides, this.history.raw, this.history.overflow,
      buffers.color, buffers.albedo, buffers.normal];
    const group = device.createBindGroup({layout: this.composePipeline!.getBindGroupLayout(0), entries: values.map((value, binding) => ({binding,
      resource: value instanceof GPUBuffer ? {buffer: value} : value.createView({dimension: '2d-array'})}))});
    const encoder = device.createCommandEncoder({label: 'Temporal composition pack'}), pass = encoder.beginComputePass();
    pass.setPipeline(this.composePipeline!); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.history.width / 8), Math.ceil(this.history.height / 8)); pass.end();
    device.queue.submit([encoder.finish()]);
    return this.engine.display._withSettings(this.displaySettings[frame], () =>
      this.replay!._composeExternalDenoiseInput({width: this.history.width, height: this.history.height, samples, ...buffers}));
  }

  private async process(flush: boolean) {
    if (!this.history) return;
    const historyReady = readyThrough(this.frames, {...this.options, postRadius: 0}, flush);
    while (this.nextWindow <= historyReady) {
      if (flush && this.finished.length >= MAX_FINISHED) return;
      const i = this.nextWindow++;
      const radius = this.options.historyRadius.max;
      const neighbors = historyNeighbors(i, this.frames, this.options, radius).filter(j => this.epochs[j] === this.epochs[i]);
      await this.window.filter(i, neighbors, this.options.mode === 'offline');
      await this.history.filter(i, [], false);
      const device = this.engine.device!;
      const mergeGroup = device.createBindGroup({layout: this.mergeWindowPipeline!.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: this.window.output}}, {binding: 1, resource: {buffer: this.history.output}}
      ]});
      const mergeEncoder = device.createCommandEncoder({label: 'Temporal window merge'});
      const mergePass = mergeEncoder.beginComputePass();
      mergePass.setPipeline(this.mergeWindowPipeline!); mergePass.setBindGroup(0, mergeGroup);
      mergePass.dispatchWorkgroups(Math.ceil(this.history.width * this.history.height / 64)); mergePass.end();
      device.queue.submit([mergeEncoder.finish()]);
      this.accumulated.set(i, copyBuffer(device, this.history.output, this.history.bytes, 'Temporal accumulated history'));
      const denoised = await this.spatial(i, this.history.output);
      if (this.options.postRadius === 0) this.spatialOutputs.set(i, denoised);
      else { await this.post.setDisplayBuffer(i, denoised); denoised.destroy(); this.history.copySurfaces(i, this.post); }
      await this.publishReady(this.options.mode === 'interactive' ? this.nextWindow - 1 : this.nextWindow - 1 - this.options.postRadius);
    }
    if (flush) await this.publishReady(this.nextWindow - 1);
  }

  private async publishReady(outputReady: number) {
    while (this.nextOutput <= outputReady) {
      if (this.finished.length >= MAX_FINISHED) {
        if (this.flushing) return;
        throw new Error('Too many finished temporal frames are waiting; drain output before pushing.');
      }
      const i = this.nextOutput++;
      const neighbors = historyNeighbors(i, this.nextWindow, {...this.options, historyRadius: {min: this.options.postRadius, max: this.options.postRadius}}, this.options.postRadius)
        .filter(j => this.epochs[j] === this.epochs[i]);
      const bytes = this.history.bytes, device = this.engine.device!;
      let denoised: GPUBuffer;
      if (this.options.postRadius === 0) { denoised = this.spatialOutputs.get(i)!; this.spatialOutputs.delete(i); }
      else { await this.post.filter(i, neighbors); this.sparkle?.filter(this.post, i, neighbors);
        denoised = copyBuffer(device, this.post.output, bytes, 'Temporal finished output'); }
      this.finished.push(new TemporalFrame(device, this.replay!, i, this.history.width, this.history.height, {
        denoised,
        accumulated: this.accumulated.get(i)!
      }));
      this.accumulated.delete(i);
    }
  }

  private resetShot() {
    this.frames = this.nextWindow = this.nextOutput = this.epoch = 0; this.epochs.length = 0; this.sampleCounts.length = 0; this.displaySettings.length = 0; this.previousOffset = undefined;
    for (const buffer of this.accumulated.values()) buffer.destroy(); this.accumulated.clear();
    for (const buffer of this.spatialOutputs.values()) buffer.destroy(); this.spatialOutputs.clear();
    for (const aovs of this.customAovs.values()) for (const buffer of Object.values(aovs)) buffer?.destroy(); this.customAovs.clear();
  }
}
