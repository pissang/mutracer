/// <reference types="@webgpu/types" preserve="true" />

import Engine from './Engine.js';
import type {DisplaySettings} from './Display.js';
import Render, {type Denoiser} from './Render.js';
import type {OIDNFilterOptions} from './oidnOptions.js';
import {mat4} from './math.js';
import {cameraApertureRadius} from './renderer/cameraLens.js';
import {TemporalHistoryGPU} from './renderer/WGPUTemporalHistory.js';
import {TemporalPostGPU} from './renderer/WGPUTemporalPost.js';
import {DirectWindowGPU} from './renderer/WGPUTemporalWindow.js';
import {createSparklePost} from './renderer/WGPUTemporalSparkle.js';
import {createOIDNFilter, type OIDNFilter} from './oidn.js';
import {hasTemporalFrameGap, historyNeighbors, isTemporalCameraCut, readyThrough, temporalLatency} from './temporal/schedule.js';
import {normalizeTemporalOptions, type NormalizedTemporalOptions} from './temporal/options.js';
import {nextTemporalMemoryPlan, planTemporalMemory, temporalHistorySlots, TEMPORAL_MAX_FINISHED, type TemporalMemoryPlan} from './temporal/memoryPlan.js';
export type {TemporalDenoiserOptions, TemporalHistoryRadius, TemporalMode, TemporalSpatialDenoiser} from './temporal/options.js';

const CAPTURE_AOVS = ['centerPosition', 'centerDepth', 'centerNormal', 'roughness', 'motion', 'id'] as const;
const composePackWGSL = /* wgsl */ `
struct Frame { size: vec2u, samples: u32, guideSlot: u32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage,read> accumulated: array<vec4f>;
@group(0) @binding(2) var guides: texture_2d_array<f32>;
@group(0) @binding(3) var<storage,read_write> color: array<vec4f>;
@group(0) @binding(4) var<storage,read_write> albedo: array<vec4f>;
@group(0) @binding(5) var<storage,read_write> normal: array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=frame.size)) {return;}
  let at=vec2i(g.xy); let rgba=accumulated[g.y*frame.size.x+g.x];
  let alb=textureLoad(guides,at,i32(frame.guideSlot*2u),0); let nrm=textureLoad(guides,at,i32(frame.guideSlot*2u+1u),0);
  let n=f32(frame.samples); let hit=floor(alb.a*n+0.5); let dst=(frame.size.y-1-g.y)*frame.size.x+g.x;
  color[dst]=vec4f(rgba.rgb*select(n,hit,hit>0.0),rgba.a*n);
  albedo[dst]=vec4f(alb.rgb*n,hit);
  normal[dst]=vec4f(select(vec3f(0),(nrm.rgb-0.5)*2.0*n,nrm.a>0.0),n);
}`;
const motionCoverageWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read> position: array<vec4u>;
struct Counts { values: array<atomic<u32>> }
@group(0) @binding(1) var<storage,read_write> counts: Counts;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(workgroup_id) group: vec3u) {
  if (g.x < arrayLength(&position) && bitcast<f32>(position[g.x].w) > 0.5) { atomicAdd(&counts.values[group.x], 1u); }
}`;

export type TemporalPixelKind = 'denoised' | 'accumulated';
export interface TemporalPlan extends TemporalMemoryPlan {}

function copyBuffer(device: GPUDevice, source: GPUBuffer, bytes: number, label: string) {
  const target = device.createBuffer({label, size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
  const encoder = device.createCommandEncoder({label});
  encoder.copyBufferToBuffer(source, 0, target, 0, bytes);
  device.queue.submit([encoder.finish()]);
  return target;
}

function isOutOfMemory(error: unknown): boolean {
  if (typeof GPUOutOfMemoryError !== 'undefined' && error instanceof GPUOutOfMemoryError) return true;
  return typeof error === 'object' && error !== null &&
    ('name' in error && (error as {name?: string}).name === 'GPUOutOfMemoryError' ||
      'message' in error && /out of memory/i.test(String((error as {message?: unknown}).message)));
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
  private source!: {color: GPUBuffer; albedo: GPUBuffer; normal: GPUBuffer; baseline?: GPUBuffer; samples: number; settings: Required<DisplaySettings>};
  private displayLinear!: boolean;
  private encodedCodes!: boolean;
  private device!: GPUDevice;
  private presentation!: Render;
  private storageWidth!: number;
  private storageHeight!: number;
  private valid = true;

  /** @internal */
  constructor(device: GPUDevice, presentation: Render, index: number, storageWidth: number, storageHeight: number,
    buffers: Record<TemporalPixelKind, GPUBuffer>, source: TemporalFrame['source'], displayLinear: boolean, encodedCodes: boolean) {
    Object.assign(this, {device, presentation, index, width: presentation.width, height: presentation.height,
      storageWidth, storageHeight, buffers, source, displayLinear, encodedCodes});
  }

  /** Reads RGBA float32 pixels. Default `'denoised'`. */
  async readPixels(kind: TemporalPixelKind = 'denoised') {
    if (!this.valid) throw new Error('This temporal frame is no longer borrowed.');
    if (kind !== 'denoised' && kind !== 'accumulated') throw new Error(`Unknown temporal pixel kind ${kind}.`);
    const bytes = this.storageWidth * this.storageHeight * 16;
    const staging = this.device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const encoder = this.device.createCommandEncoder({label: 'Temporal frame readback'});
      encoder.copyBufferToBuffer(this.buffers[kind], 0, staging, 0, bytes);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      if (kind === 'denoised' && this.encodedCodes) {
        for (let i = 0; i < data.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) {
            const encoded = Math.max(0, Math.min(1, data[i + channel] / 255));
            data[i + channel] = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
          }
          data[i + 3] = 1;
        }
      }
      return this.presentation._cropOutput({width: this.storageWidth, height: this.storageHeight, data});
    } finally { staging.destroy(); }
  }

  /** @internal */ _buffer(kind: TemporalPixelKind) {
    if (!this.valid) throw new Error('This temporal frame is no longer borrowed.');
    return this.buffers[kind];
  }
  /** @internal */ _withPresentation<T>(callback: (render: Render) => T): T {
    if (!this.valid) throw new Error('This temporal frame is no longer borrowed.');
    this.presentation.engine.display._withSettings(this.source.settings, () =>
      this.presentation._composeExternalDenoiseInput({width:this.width,height:this.height,samples:this.source.samples,
        color:this.source.color,albedo:this.source.albedo,normal:this.source.normal}));
    this.presentation.engine.display._configure(this.presentation);
    this.presentation._setExternalDenoisedOutput(this.buffers.denoised,this.displayLinear,this.encodedCodes,this.source.baseline);
    return callback(this.presentation);
  }
  /** @internal */ _release() {
    if (!this.valid) return;
    this.valid = false;
    this.buffers.denoised.destroy(); this.buffers.accumulated.destroy();
    this.source.color.destroy(); this.source.albedo.destroy(); this.source.normal.destroy();
    this.source.baseline?.destroy();
  }
}

/** GPU temporal history, spatial denoising and stabilisation for animation renders. */
export class TemporalDenoiser {
  /** Number of pushes before an output can become drainable. A budget-reduced value becomes active after the first push. */
  get latency() { return temporalLatency(this.activeOptions); }
  private readonly options: NormalizedTemporalOptions;
  private activeOptions: NormalizedTemporalOptions;
  /** Effective allocation after budgeting; undefined until the first push. */
  get plan(): TemporalPlan | undefined { return this._plan; }
  private _plan?: TemporalPlan;
  private engine: Engine;
  private attached?: Render;
  private detachRender?: () => void;
  private history?: TemporalHistoryGPU;
  private window?: DirectWindowGPU;
  private post?: TemporalPostGPU;
  private sparkle?: Awaited<ReturnType<typeof createSparklePost>>;
  private oidn?: OIDNFilter;
  private frames = 0;
  private pushIndex = 0;
  private nextWindow = 0;
  private nextOutput = 0;
  private finished: TemporalFrame[] = [];
  private disposed = false;
  private flushing = false;
  private pushing = false;
  private deviceLost = false;
  private deviceGeneration?: number;
  private watchedDevice?: GPUDevice;
  private previousOffset?: number;
  private previousFrameSequence?: number;
  private previousScene?: Engine['scene'];
  private previousCameraSource?: Engine['camera'];
  private previousSceneRevision?: number;
  private warnedOffset = false;
  private warnedBudget = false;
  private accumulated = new Map<number, GPUBuffer>();
  private spatialOutputs = new Map<number, GPUBuffer>();
  private epoch = 0;
  private epochs: number[] = [];
  private materialRevisionFrames = new Map<number,Map<number,number>>();
  private globalIndices: number[] = [];
  private sampleCounts: number[] = [];
  private displaySettings: Required<DisplaySettings>[] = [];
  private customAovs = new Map<number, Partial<Record<import('./renderer/aov.js').AovKind, GPUBuffer>>>();
  private replay?: Render;
  private composePipeline?: GPUComputePipeline;
  private motionCoveragePipeline?: GPUComputePipeline;
  private motionCoverageCounts?: GPUBuffer;
  private composeParams?: GPUBuffer;
  private presentationInputs = new Map<number, {color: GPUBuffer; albedo: GPUBuffer; normal: GPUBuffer}>();

  constructor(engine: Engine, options: import('./temporal/options.js').TemporalDenoiserOptions = {}) {
    this.engine = engine;
    this.options = normalizeTemporalOptions(options);
    this.activeOptions = this.options;
  }

  /** Attaches hidden capture AOVs to one render and returns a detach function. */
  attach(render: Render) {
    this.assertAlive();
    if (render.engine !== this.engine) throw new Error('Temporal denoiser and render must use the same engine.');
    if (this.attached && this.attached !== render) throw new Error('A temporal denoiser can attach to only one render at a time.');
    if (this.attached === render) throw new Error('This render is already attached.');
    if (render.denoiser) console.warn('The attached render has its own denoiser; temporal capture ignores that result.');
    const custom = this.activeOptions.denoiser?.type === 'custom' ? this.activeOptions.denoiser.aovs ?? [] : [];
    const detach = render._attachTemporal([...new Set([...CAPTURE_AOVS, ...custom])] as any);
    this.attached = render;
    this.detachRender = () => {
      if (this.attached !== render) return;
      if (this.pushing) throw new Error('Cannot detach while a temporal push is active.');
      detach(); this.attached = undefined; this.detachRender = undefined;
    };
    return this.detachRender;
  }

  /** Captures one converged frame. Resolves after its GPU capture has been submitted. */
  async push(render: Render) {
    this.assertAlive();
    if (this.flushing) throw new Error('Cannot push while flush is active.');
    if (this.pushing) throw new Error('A temporal push is already active.');
    this.pushing = true;
    try {
      await this.engine.init();
      if (this.engine.backend !== 'webgpu' || !this.engine.device) throw new Error('Temporal denoising requires WebGPU.');
      if (this.deviceLost || (this.deviceGeneration !== undefined && this.engine._deviceGeneration !== this.deviceGeneration)) throw new Error('The WebGPU device was lost; create a new temporal denoiser.');
      if (render !== this.attached) throw new Error('Temporal push requires the attached render.');
      if (!render.converged) throw new Error('Temporal push requires a converged render.');
      if (this.finished.length >= TEMPORAL_MAX_FINISHED) throw new Error('Too many finished temporal frames are waiting; drain output before pushing.');
      if (this.replay && (render.width !== this.replay.width || render.height !== this.replay.height)) {
        throw new Error('Temporal frame dimensions changed within a shot.');
      }
      const metadata = render._temporalMetadata;
      if (!metadata.camera) throw new Error('Temporal push requires a completed converge call.');
      // The renderer may pad the capture grid while presenting a center crop.
      const captureWidth = metadata.captureWidth ?? render.width;
      const captureHeight = metadata.captureHeight ?? render.height;
      const revisionEntries = this.activeOptions.historyInvalidation === 'auto' ? this.engine._temporalMaterialRevisionEntries : [];
      await this.ensureResources(captureWidth, captureHeight, revisionEntries.length);
      if (captureWidth !== this.history!.width || captureHeight !== this.history!.height) {
        throw new Error('Temporal frame dimensions changed within a shot.');
      }
      if (hasTemporalFrameGap(this.previousFrameSequence, metadata.frameSequence)) this.epoch++;
      if (this.activeOptions.historyInvalidation === 'auto' && this.previousScene !== undefined && metadata.scene !== this.previousScene) this.epoch++;
      if (this.activeOptions.historyInvalidation === 'auto' && this.previousSceneRevision !== undefined && metadata.sceneRevision !== this.previousSceneRevision) this.epoch++;
      if (this.activeOptions.historyInvalidation === 'auto' && this.previousCameraSource !== undefined && metadata.cameraSource !== this.previousCameraSource) this.epoch++;
      if (!this.replay) {
        this.replay = new Render(this.engine, {width: render.width, height: render.height, maxSamples: 1});
        await this.replay.converge({samples: 1, camera: metadata.camera});
      }
      if (this.previousOffset === metadata.sampleSequenceOffset && !this.warnedOffset) {
        this.warnedOffset = true; console.warn('Consecutive temporal frames use the same sampleSequenceOffset; correlated noise will not average out.');
      }
      this.previousOffset = metadata.sampleSequenceOffset;
      const direct = metadata as typeof metadata & {projection?: number[]; viewProjection?: number[]; apertureRadius?: number; focusDistance?: number};
      const targetCamera = metadata.targetCamera ?? metadata.camera;
      const frame = this.frames;
      const sampleCount = metadata.samples;
      const settings = this.engine.display._snapshotSettings();
      await render._captureTemporal(async input => {
        if (input.width !== captureWidth || input.height !== captureHeight) {
          throw new Error('Temporal render dimensions changed during capture.');
        }
        const projection = direct.projection ?? targetCamera.getProjectionMatrix(input.width / input.height);
        const view = mat4.create();
        mat4.invert(view, targetCamera.transform);
        const viewProjection = direct.viewProjection ?? mat4.mul(mat4.create(), projection, view);
        const aovs = input.aovs!;
        if (this.activeOptions.denoiser?.type === 'custom') for (const kind of this.activeOptions.denoiser.aovs ?? []) {
          if (!aovs[kind]) throw new Error(`Temporal capture is missing custom denoiser AOV ${kind}.`);
        }
        await this.history!.capture(frame, {
          viewProjection, projection, apertureRadius: direct.apertureRadius ?? cameraApertureRadius(targetCamera),
          focusDistance: direct.focusDistance ?? targetCamera.focusDistance
        }, {color: input.color, albedo: input.albedo, normal: input.normal, centerDepth: aovs.centerDepth!,
          centerNormal: aovs.centerNormal!, roughness: aovs.roughness!, motion: aovs.motion!, id: aovs.id!}, revisionEntries);
        if (this.activeOptions.historyInvalidation === 'auto' && aovs.centerPosition && frame > 0 && this.activeOptions.historyRadius.max > 0 &&
            this.previousFrameSequence === metadata.frameSequence - 1 && this.previousSceneRevision === metadata.sceneRevision &&
            this.previousScene === metadata.scene && this.previousCameraSource === metadata.cameraSource &&
            this.epochs[frame - 1] === this.epoch &&
            await this.cameraCutCoverage(frame, aovs.centerPosition)) this.epoch++;
        if (this.activeOptions.denoiser?.type === 'custom' && this.activeOptions.denoiser.aovs?.length) {
          const copies: Partial<Record<import('./renderer/aov.js').AovKind, GPUBuffer>> = {};
          const encoder = this.engine.device!.createCommandEncoder({label: 'Temporal custom denoiser AOV capture'});
          for (const kind of this.activeOptions.denoiser.aovs) {
            const source = aovs[kind];
            if (!source) throw new Error(`Temporal capture is missing custom denoiser AOV ${kind}.`);
            const copy = this.engine.device!.createBuffer({label: `Temporal custom ${kind} AOV`, size: source.size,
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
            encoder.copyBufferToBuffer(source, 0, copy, 0, source.size); copies[kind] = copy;
          }
          this.engine.device!.queue.submit([encoder.finish()]); this.customAovs.set(frame, copies);
        }
      });
      if(this.activeOptions.postRadius>0)this.materialRevisionFrames.set(frame,new Map(revisionEntries));
      this.frames++;
      this.globalIndices[frame] = this.pushIndex;
      this.pushIndex++;
      this.previousFrameSequence = metadata.frameSequence;
      this.previousScene = metadata.scene;
      this.previousCameraSource = metadata.cameraSource;
      this.previousSceneRevision = metadata.sceneRevision;
      this.epochs[frame] = this.epoch;
      this.sampleCounts[frame] = sampleCount;
      this.displaySettings[frame] = settings;
      await this.process(false);
    } finally { this.pushing = false; }
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
    this.assertAlive();
    if (this.pushing) throw new Error('Cannot flush while a push is active.');
    this.flushing = true;
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
    for (const input of this.presentationInputs.values()) for (const buffer of Object.values(input)) buffer.destroy();
    this.presentationInputs.clear();
    for (const aovs of this.customAovs.values()) for (const buffer of Object.values(aovs)) buffer?.destroy(); this.customAovs.clear();
    this.releaseResources(); this.replay?.dispose(); this.replay = undefined;
  }

  private assertAlive() { if (this.disposed) throw new Error('Temporal denoiser is disposed.'); }
  private revisionMaterialCapacity = 0;
  private async ensureResources(width: number, height: number, materialCount=0) {
    if (this.history) {
      const nextCapacity=Math.max(1,materialCount);
      if(nextCapacity>this.revisionMaterialCapacity){
        const delta=nextCapacity-this.revisionMaterialCapacity;
        const postSlots=this.activeOptions.mode==='offline'?this.activeOptions.postRadius*2+1:this.activeOptions.postRadius+1;
        const extra=delta*8+(this.activeOptions.postRadius>0?delta*postSlots*4:0);
        if(this.options.memoryBudget!==undefined && (this._plan?.bytes??0)+extra>this.options.memoryBudget){
          throw new RangeError(`Temporal memory budget cannot fit material revision entries (${(this._plan?.bytes??0)+extra} bytes).`);
        }
        this._plan=Object.freeze({...this._plan!,bytes:this._plan!.bytes+extra});
        this.revisionMaterialCapacity=nextCapacity;
        await this.post?.ensureMaterialCapacity(materialCount);
      }
      return;
    }
    const device = this.engine.device!;
    if (this.deviceGeneration !== undefined && this.engine._deviceGeneration !== this.deviceGeneration) {
      this.deviceLost = true;
      throw new Error('The WebGPU device was lost; create a new temporal denoiser.');
    }
    this.deviceGeneration ??= this.engine._deviceGeneration;
    if (this.watchedDevice !== device) {
      this.watchedDevice = device;
      void device.lost.then(() => { this.deviceLost = true; });
    }
    let candidate = planTemporalMemory(width, height, this.options, device.limits, materialCount);
    let retried = false;
    for (;;) {
      this.activeOptions = Object.freeze({...this.options, historyRadius: candidate.historyRadius, postRadius: candidate.postRadius});
      device.pushErrorScope('out-of-memory');
      let allocationError: unknown;
      try { await this.allocateResources(width, height, materialCount); }
      catch (error) { allocationError = error; }
      let scopedError: GPUError | null;
      try { scopedError = await device.popErrorScope(); }
      catch (error) { this.releaseResources(); this.activeOptions = this.options; throw error; }
      const error = scopedError ?? allocationError;
      if (!error) {
        this._plan = Object.freeze({...candidate});
        this.revisionMaterialCapacity=Math.max(1,materialCount);
        if (!this.warnedBudget && (candidate.historyRadius.min !== this.options.historyRadius.min ||
          candidate.historyRadius.max !== this.options.historyRadius.max || candidate.postRadius !== this.options.postRadius)) {
          this.warnedBudget = true;
          console.warn(`Temporal memory plan reduced to history ${candidate.historyRadius.min}–${candidate.historyRadius.max}, post ${candidate.postRadius} (${candidate.bytes} bytes).`);
        }
        return;
      }
      this.releaseResources();
      if ((!scopedError && !isOutOfMemory(error)) || retried) { this.activeOptions = this.options; throw error; }
      const next = nextTemporalMemoryPlan(width, height, this.options, candidate, device.limits, materialCount);
      if (!next) { this.activeOptions = this.options; throw error; }
      retried = true; candidate = next;
    }
  }

  private async allocateResources(width: number, height: number, materialCount=0) {
    const device = this.engine.device!;
    const {mode, historyRadius, denoiser} = this.activeOptions;
    const guideSlots = mode === 'offline' ? historyRadius.max + 1 : 1;
    this.history = await TemporalHistoryGPU.create(device, width, height, temporalHistorySlots(this.activeOptions),
      guideSlots, denoiser?.type === 'custom');
    // The selected mixed window stays enabled when the post sparkle pass is disabled.
    this.window = await DirectWindowGPU.create(this.history, historyRadius.min !== historyRadius.max);
    if (this.activeOptions.postRadius > 0) {
      const postSlots = this.activeOptions.mode === 'offline' ? this.activeOptions.postRadius * 2 + 1 : this.activeOptions.postRadius + 1;
      this.post = await TemporalPostGPU.create(this.history, postSlots, materialCount);
      if (this.activeOptions.stabilizeSparkle) this.sparkle = await createSparklePost(device);
    }
    if (this.activeOptions.denoiser?.type === 'oidn') {
      const {type: _type, ...oidnOptions} = this.activeOptions.denoiser;
      this.oidn = await createOIDNFilter(this.engine, oidnOptions as OIDNFilterOptions);
    }
    const module = device.createShaderModule({label: 'Temporal composition pack', code: composePackWGSL});
    this.composePipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
    const motionModule = device.createShaderModule({label: 'Temporal motion coverage', code: motionCoverageWGSL});
    this.motionCoveragePipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: motionModule, entryPoint: 'main'}});
    this.motionCoverageCounts = device.createBuffer({label: 'Temporal motion coverage counts', size: Math.ceil(width * height / 64) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
    this.composeParams = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  }

  private async spatial(frame: number, accumulated: GPUBuffer) {
    const device = this.engine.device!, bytes = this.history!.bytes;
    const output = device.createBuffer({label: 'Temporal spatial output', size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
    if (this.oidn) {
      const input = this.composeForOIDN(frame);
      await this.oidn.denoise({width: this.history!.width, height: this.history!.height, ...input, output});
    }
    else if (this.activeOptions.denoiser?.type === 'custom') {
      const guides = this.history!.getCustomGuides(frame);
      const denoiser = this.activeOptions.denoiser.denoiser as Denoiser;
      await this.engine._prepareCustomDenoiser(denoiser, this.history!.width, this.history!.height);
      const controller = new AbortController();
      try {
        await denoiser.denoise({device, width: this.history!.width, height: this.history!.height,
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

  private async cameraCutCoverage(frame: number, position: GPUBuffer) {
    const device = this.engine.device!, counts = this.motionCoverageCounts!;
    const readback = device.createBuffer({label: 'Temporal motion coverage readback', size: counts.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const group = device.createBindGroup({layout: this.motionCoveragePipeline!.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: position}}, {binding: 1, resource: {buffer: counts}}
      ]});
      const encoder = device.createCommandEncoder({label: 'Temporal motion coverage reduction'});
      encoder.clearBuffer(counts); const pass = encoder.beginComputePass();
      pass.setPipeline(this.motionCoveragePipeline!); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(position.size / 16 / 64)); pass.end();
      encoder.copyBufferToBuffer(counts, 0, readback, 0, counts.size); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const partial = new Uint32Array(readback.getMappedRange().slice(0));
      let surfaces = 0; for (const count of partial) surfaces += count;
      readback.unmap();
      if (surfaces === 0) return true;
      this.engine.device!.queue.writeBuffer(this.window!.rejects, 0, new Uint32Array(16));
      await this.window!.dispatch(frame, frame - 1, this.activeOptions.mode === 'offline', 1,
        this.activeOptions.historyRadius.min, this.activeOptions.historyRadius.max, false);
      const validation = new Uint32Array(await this.window!.read(this.window!.rejects, 64));
      const accepted = validation[0];
      return isTemporalCameraCut(surfaces, accepted);
    } finally { if (readback.mapState === 'mapped') readback.unmap(); readback.destroy(); }
  }

  private packExternal(frame: number, accumulated: GPUBuffer) {
    const device = this.engine.device!, history = this.history!;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const create = (name: string) => device.createBuffer({label: 'Temporal presentation ' + name, size: history.bytes, usage});
    const buffers = {color: create('color'), albedo: create('albedo'), normal: create('normal')};
    this.presentationInputs.set(frame, buffers);
    const samples = this.sampleCounts[frame];
    device.queue.writeBuffer(this.composeParams!, 0, new Uint32Array([history.width, history.height, samples, history.guideSlot(frame)]));
    const values = [this.composeParams!, accumulated, history.guides,
      buffers.color, buffers.albedo, buffers.normal];
    const group = device.createBindGroup({layout: this.composePipeline!.getBindGroupLayout(0), entries: values.map((value, binding) => ({binding,
      resource: value instanceof GPUBuffer ? {buffer: value} : value.createView({dimension: '2d-array'})}))});
    const encoder = device.createCommandEncoder({label: 'Temporal composition pack'}), pass = encoder.beginComputePass();
    pass.setPipeline(this.composePipeline!); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(history.width / 8), Math.ceil(history.height / 8)); pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private composeForOIDN(frame: number) {
    const buffers = this.presentationInputs.get(frame)!;
    const samples = this.sampleCounts[frame];
    return this.engine.display._withSettings(this.displaySettings[frame], () =>
      this.replay!._composeExternalDenoiseInput({width: this.history!.width, height: this.history!.height, samples, ...buffers}));
  }

  private async process(flush: boolean) {
    if (!this.history) return;
    const historyReady = readyThrough(this.frames, {...this.activeOptions, postRadius: 0}, flush);
    while (this.nextWindow <= historyReady) {
      if (flush && this.finished.length >= TEMPORAL_MAX_FINISHED) return;
      const i = this.nextWindow++;
      const radius = this.activeOptions.historyRadius.max;
      const neighbors = historyNeighbors(i, this.frames, this.activeOptions, radius).filter(j => this.epochs[j] === this.epochs[i]);
      const output = await this.window!.filter(i, neighbors, this.activeOptions.mode === 'offline',
        this.activeOptions.historyRadius.min, this.activeOptions.historyRadius.max);
      const device = this.engine.device!;
      this.accumulated.set(i, copyBuffer(device, output, this.history.bytes, 'Temporal accumulated history'));
      this.packExternal(i, output);
      const denoised = await this.spatial(i, output);
      if (!this.post) this.spatialOutputs.set(i, denoised);
      else { await this.post.setDisplayBuffer(i, denoised); denoised.destroy(); }
      await this.publishReady(this.activeOptions.mode === 'interactive' ? this.nextWindow - 1 : this.nextWindow - 1 - this.activeOptions.postRadius);
    }
    if (flush) await this.publishReady(this.nextWindow - 1);
  }

  private async publishReady(outputReady: number) {
    while (this.nextOutput <= outputReady) {
      if (this.finished.length >= TEMPORAL_MAX_FINISHED) {
        if (this.flushing) return;
        throw new Error('Too many finished temporal frames are waiting; drain output before pushing.');
      }
      const i = this.nextOutput++;
      const neighbors = historyNeighbors(i, this.nextWindow, {...this.activeOptions, historyRadius: {min: this.activeOptions.postRadius, max: this.activeOptions.postRadius}}, this.activeOptions.postRadius)
        .filter(j => this.epochs[j] === this.epochs[i]);
      const bytes = this.history!.bytes, device = this.engine.device!;
      let denoised: GPUBuffer;
      if (!this.post) { denoised = this.spatialOutputs.get(i)!; this.spatialOutputs.delete(i); }
      else {
        const currentRevisions=this.materialRevisionFrames.get(i)??new Map<number,number>();
        const changedByFrame=new Map<number,readonly number[]>();
        for(const j of neighbors){
          const previous=this.materialRevisionFrames.get(j)??new Map<number,number>();
          const changed=[...currentRevisions].filter(([id,revision])=>previous.get(id)!==revision).map(([id])=>id);
          changedByFrame.set(j,changed);
        }
        await this.post.filter(i, neighbors, false, undefined, changedByFrame); this.sparkle?.filter(this.post, i, neighbors);
        denoised = copyBuffer(device, this.post.output, bytes, 'Temporal finished output');
      }
      const packed = this.presentationInputs.get(i)!;
      const source = {...packed, samples: this.sampleCounts[i], settings: this.displaySettings[i], baseline: undefined as GPUBuffer | undefined};
      if (this.activeOptions.denoiser?.type === 'oidn') {
        const composed=this.engine.display._withSettings(source.settings,()=>this.replay!._composeExternalDenoiseInput({
          width:this.history!.width,height:this.history!.height,samples:source.samples,color:source.color,albedo:source.albedo,normal:source.normal}));
        source.baseline=copyBuffer(device,composed.color,bytes,'Temporal captured presentation baseline');
      }
      this.finished.push(new TemporalFrame(device, this.replay!, this.globalIndices[i], this.history!.width, this.history!.height, {
        denoised,
        accumulated: this.accumulated.get(i)!
      },source,this.activeOptions.denoiser?.type === 'oidn',this.activeOptions.postRadius > 0));
      this.accumulated.delete(i);
      this.presentationInputs.delete(i);
      this.materialRevisionFrames.delete(i-this.activeOptions.postRadius);
    }
  }

  private resetShot() {
    this.frames = this.nextWindow = this.nextOutput = this.epoch = 0; this.epochs.length = 0; this.materialRevisionFrames.clear(); this.globalIndices.length = 0; this.sampleCounts.length = 0; this.displaySettings.length = 0; this.previousOffset = undefined; this.previousFrameSequence = undefined; this.previousScene = undefined; this.previousCameraSource = undefined; this.previousSceneRevision = undefined;
    for (const buffer of this.accumulated.values()) buffer.destroy(); this.accumulated.clear();
    for (const buffer of this.spatialOutputs.values()) buffer.destroy(); this.spatialOutputs.clear();
    for (const input of this.presentationInputs.values()) for (const buffer of Object.values(input)) buffer.destroy();
    this.presentationInputs.clear();
    for (const aovs of this.customAovs.values()) for (const buffer of Object.values(aovs)) buffer?.destroy(); this.customAovs.clear();
    this.releaseResources();
    this.replay?.dispose(); this.replay = undefined;
    this.activeOptions = this.options;
  }

  private releaseResources() {
    this.sparkle?.dispose(); this.sparkle = undefined;
    this.oidn?.dispose(); this.oidn = undefined;
    this.history?.dispose(); this.history = undefined;
    this.window?.dispose(); this.window = undefined;
    this.post?.dispose(); this.post = undefined;
    this.composeParams?.destroy(); this.composeParams = undefined;
    this.composePipeline = undefined;
    this.motionCoveragePipeline = undefined; this.motionCoverageCounts?.destroy(); this.motionCoverageCounts = undefined;
    this._plan = undefined;
    this.revisionMaterialCapacity=0;
  }
}
