import type {AovKind} from './renderer/aov.js';
import {aovMask} from './renderer/aov.js';
import {displayAovKind} from './renderer/aovDisplay.js';
import type {DisplayChannel} from './renderer/RenderingPipeline.js';
import { Events } from './util/events.js';
import type Engine from './Engine.js';
import type Camera from './scene/Camera.js';
import { cameraSnapshot } from './renderer/cameraSnapshot.js';
import type { AlphaBlendStrategy } from './renderer/RenderingPipeline.js';
import { collectTraceSettings, imageSettingsKey } from './settings/render.js';
import type { SamplingPattern } from './renderer/sampling.js';
import type { RenderTarget, TraceSettings } from './renderer/renderPipeline.js';
import type {DenoiserHandle} from './renderer/denoiser.js';
import type {OwnedDenoiser} from './renderer/ownedDenoiser.js';
import type { OIDNModel, OIDNEngine, OIDNPrecision, OIDNHDRTransfer, OIDNDynamicTileSetting, OIDNAuxiliaryModelUrls } from './oidn.js';
import { DEFAULT_JNLM_OPTIONS, createJNLMDenoiser, type JNLMOptions } from './renderer/jnlm.js';
import type { OfflineAdaptiveSamplingOptions, OfflineVarianceHistory } from './renderer/OfflineAdaptiveSampling.js';
import { nextPreviewScale } from './renderer/util.js';
import {scheduleFrame} from './util/frame.js';

/** Complete-sample notification, including the backend's measured sample time. */
export interface SampleEvent { samples: number; isFirstFrame: boolean; frameTimeMs: number; }
/** State of one independent accumulation. Default preparing. */
export type RenderStatus = 'preparing' | 'compiling' | 'converging' | 'denoising' | 'finished' | 'error';
/** Execution overrides for one refine call; accumulated samples are retained. */
export interface RefineOptions {
  /** Batch several samples in this call. Default this render's batchSamples. */ batchSamples?: boolean;
  /** Positive finite WebGPU queue budget in milliseconds; capped by timeBudgetMs, ignored on WebGL. Default timeBudgetMs. */ targetBatchTimeMs?: number;
  /** Leave the displayed image unchanged, for calls between display frames; the next presentation or pixel read updates it once with every new sample. Ignored on WebGL. Default false. */ deferResolve?: boolean;
}
/** When a render filters its complete samples. Default converged. */
export type DenoiseSchedule = 'converged' | 'progressive' | 'every-sample';
/** Caller-owned WebGPU filter. Render/Engine never dispose it; calls on one engine are serialized. */
export interface Denoiser {
  /** Optional preallocation before first use or after device/dimension changes. Default undefined. The device may change after recovery; recreate device-owned resources then. */
  prepare?(input: {device: GPUDevice; width: number; height: number}): Promise<void>;
  /** Write all output RGB, then resolve after submitting GPU work. Abort on input changes, restart, replacement or disposal; aborted results are discarded even if this resolves. Buffers are borrowed until settlement; do not retain or destroy them. */
  denoise(input: DenoiseInput, context: {signal: AbortSignal; schedule: DenoiseSchedule}): Promise<void>;
}
/** Borrowed, tightly packed rgba32float buffers, top row first, width*height*16 bytes of image data. */
export interface DenoiseInput {
  /** Requested primary-surface buffers, top row first; id is rgba32uint, others rgba32float. Default undefined. Borrowed until denoise settles. */ aovs?: Readonly<Partial<Record<AovKind,GPUBuffer>>>;
  /** Engine WebGPU device; may change after device loss/recovery. */ device: GPUDevice;
  /** Actual internal width, including backend alignment. */ width: number;
  /** Actual internal height, including backend alignment. */ height: number;
  /** Read-only native resolved linear HDR ray color, before exposure, grading, tone mapping, vignette, bloom and display background/catcher composition. RGB uses native hit-count normalization (flat primary misses are averaged by samples); alpha is raw path coverage. Usage STORAGE | COPY_SRC | COPY_DST. */ color: GPUBuffer;
  /** Read-only resolved linear RGB albedo averaged over complete samples; alpha is primary-hit coverage. Same packing/usage as color. */ albedo: GPUBuffer;
  /** Read-only resolved world-space RGB normal encoded as averaged normal*.5+.5, without renormalizing; alpha 1 for a valid surface, otherwise zero RGBA. Same packing/usage as albedo. */ normal: GPUBuffer;
  /** Write linear HDR RGB here. Same packing/usage as color; alpha is ignored and original path coverage is retained. */ output: GPUBuffer;
}
/** Third-party WebGPU filter; ignored with one warning on WebGL. */
export interface CustomDenoiserOptions {
  /** Optional AOV inputs; automatically enables their passes for this render. Default []. */ aovs?: readonly AovKind[];
  /** Required implementation selector. */ type: 'custom';
  /** Required caller-owned instance, keyed by object identity; never serialized or released by Render/Engine. */ denoiser: Denoiser;
  /** When to filter complete samples. Default converged. */ schedule?: DenoiseSchedule;
}
/** Built-in joint non-local means filter on both backends. */
export interface JNLMDenoiserOptions extends JNLMOptions {
  /** Required implementation selector. */ type: 'jnlm';
  /** When to filter complete samples. Default converged. */ schedule?: DenoiseSchedule;
}
/** Loading and execution options shared by both OIDN network sources. */
interface OIDNSettings {
  /** Required implementation selector. */ type: 'oidn';
  /** When to filter complete samples. Default converged. */ schedule?: DenoiseSchedule;
  /** Override albedo and normal prefilter networks. Default packaged filters for cleanAuxLarge, otherwise undefined. */ auxiliaryModelUrls?: OIDNAuxiliaryModelUrls;
  /** Execution backend. Default auto (native WGSL unless WebNN is selected). */ engine?: OIDNEngine;
  /** WGSL precision. Default auto (fp16 when shader-f16 is available). */ precision?: OIDNPrecision;
  /** Adaptive tile controller. Default enabled with minTileSize 256, initialTileSize 432, targetTileTimeMs 16, adjustmentStep 16. */ dynamicTile?: OIDNDynamicTileSetting;
  /** Maximum OIDN output tile edge in pixels. Default `512`. */ maxTileSize?: number;
  /** Abort weight downloads. Default undefined; does not distinguish cached networks. */ signal?: AbortSignal;
}
/** OIDN configuration on WebGPU: choose a packaged model or an explicit network URL. */
export type OIDNDenoiserOptions = OIDNSettings & (
  | {
    /** Packaged network. Default standard. */ model?: OIDNModel;
    /** Weight directory override. Default bundled standard/small assets and CDN large weights. */ weightsBaseUrl?: string | URL;
    weightsUrl?: never; aux?: never; hdr?: never; hdrTransfer?: never;
  }
  | {
    /** Custom network file. Required in this branch; failures never fall back to CDN. */ weightsUrl: string | URL;
    /** Custom model consumes albedo and normal. Default true. */ aux?: boolean;
    /** Custom model consumes HDR color. Default true. */ hdr?: boolean;
    /** Custom model HDR encoding. Default pu. */ hdrTransfer?: OIDNHDRTransfer;
    model?: never; weightsBaseUrl?: never;
  }
);
/** Assign a complete configuration, or null to disable denoising. The type selector is required. */
export type DenoiserOptions = JNLMDenoiserOptions | OIDNDenoiserOptions | CustomDenoiserOptions;

/** Optional caustic estimators. All are disabled by default. Photon estimators use PT when a smooth caster has stochastic blend coverage. */
export interface CausticSettings {
  /** WebGPU progressive photon mapping for caustics beyond directly visible light paths; ignored on WebGL. Default `false`. */
  photonMapping?: boolean | {
    /** Emitted photons per batch; 28 bytes per photon plus up to 13 MiB of overhead. Rounded to a positive integer and reduced to fit device limits and a 128 MiB batch budget. Default pixel count / 4. */ photonsPerSample?: number;
    /** Positive initial gather radius in scene units. Default 3% of the caster bounding sphere radius. */ initialRadius?: number;
  };
  /**
   * WebGPU light tracing for directly visible caustic paths; ignored on WebGL.
   * Default `false`.
   */ lightTracing?: boolean | {
    /** Emitted photons per sample, rounded to a positive integer and capped by the device dispatch limit. Default pixel count / 4. */
    photonsPerSample?: number;
  };
}

/** Optional per-render execution and image-quality settings. */
export interface RenderSettings {
  /** Optional surface outputs. Default []; disabled outputs allocate no AOV resources. */ aovs?: readonly AovKind[];
  /** Independent AOV sample cap, positive integer. Default 16. */ aovSamples?: number;
  /** Maximum complete samples. Default 2048. */ maxSamples?: number;
  /**
   * Maximum scattering depth, rounded and clamped to [1, 20] (NaN becomes 1).
   * Total path events, including transmission and alpha skips, are capped at 20
   * and at three times this depth. Intel Mac WebGL uses min(depth, 3), doubled
   * for scenes with transmission or alpha, with its existing early termination.
   * Default 3.
   */ bounces?: number;
  /** Radiance clamp; 0 disables it. Default 0. */ clamping?: number;
  /** Sampling sequence. Default sobol. */ samplingPattern?: SamplingPattern;
  /** Caustic estimators. All are disabled by default. */ caustics?: CausticSettings;
  /** Light candidates per vertex; WebGPU only, ignored on WebGL. Default 4. */ directLightCandidates?: number;
  /** Rounded material edges. Default true. */ bevel?: boolean;
  /** Bevel neighborhood probes, clamped to 1–32. Default 8. */ bevelSamples?: number;
  /** Wavelengths per dispersion sample. Default 3; 1 selects one random wavelength. */ dispersionWavelengths?: 1 | 3;
  /** Primary-ray alpha blend strategy; WebGPU only. Default stochastic. */ alphaBlendStrategy?: AlphaBlendStrategy;
  /** Minimum transmissive path alpha, using path depth. Default 1. Changes restart this accumulation. */ transmissiveOutputAlphaMin?: number;
  /** Tile execution budget in milliseconds. Default 21. */ timeBudgetMs?: number;
  /** Maximum tiles per frame. Default Infinity. */ maxTiles?: number;
  /** Let one refine submit several samples, up to timeBudgetMs of GPU work; WebGPU requires GPU timestamps. RenderLoop also keeps batching between display frames. Default false. */ batchSamples?: boolean;
  /** @deprecated Use batchSamples; this alias will be removed in a later release. Default false. */ allowMultipleSamplesPerFrame?: boolean;
  /** Adapt scale to frame timing; minScale must not exceed resolutionScale. Default false. */ adaptiveResolution?: {targetFrameMs: number; minScale: number} | false;
  /** Single-level fallback on the same engine. Default null. */ fallback?: Render | null;
  /** Denoising configuration. Default null. */ denoiser?: DenoiserOptions | null;
}
/** Constructor options: fixed dimensions and canvas-relative scale are mutually exclusive. */
export type RenderOptions = RenderSettings & (
  | { /** Fixed width in pixels, paired with height. */ width: number; /** Fixed height in pixels, paired with width. */ height: number; resolutionScale?: never }
  | { /** Canvas-relative resolution scale. Default 1. */ resolutionScale?: number; width?: never; height?: never }
);
/** Deterministic offline execution options. */
export interface ConvergeOptions {
  /** Final complete-sample budget. Required. */ samples: number;
  /** Camera override for this output only, copied on entry. Default committed engine camera. */ camera?: Camera;
  /** Two-stage variance sampling; WebGPU only, ignored on WebGL. Default undefined. */ adaptiveSampling?: Omit<OfflineAdaptiveSamplingOptions, 'maxSamples'>;
  /** Deterministic sequence base. Default 0. */ sampleSequenceOffset?: number;
  /** Maximum samples per submission batch. Default 8. */ samplesPerBatch?: number;
  /** WebGPU target batch completion time in milliseconds. Default undefined (fixed batch size). */ targetBatchTimeMs?: number;
  /** Delay between intermediate resolved images in milliseconds. Default undefined (resolve only at the end). */ previewIntervalMs?: number;
  /** Batch progress callback. Default undefined. */ onProgress?: (progress: {stage: 'pilot' | 'final' | 'denoising'; samples: number; targetSamples: number}) => void;
  /** Cancels the task. Default undefined. */ signal?: AbortSignal;
  /** Timeout per stage in milliseconds. Default 600000. */ timeoutMs?: number;
}
/** Result of deterministic offline convergence. */
export interface ConvergeResult {
  samples: number; averageSamplesPerPixel: number; pilotSamples: number;
  varianceHistory?: OfflineVarianceHistory; adaptiveSampling: boolean;
}

let oidnModule: Promise<typeof import('./renderer/oidnNetwork.js')> | undefined;
const loadOIDN = () => oidnModule ??= import('./renderer/oidnNetwork.js');

function validateDenoiserOptions(options: DenoiserOptions) {
  if (!options || typeof options !== 'object' || (options.type !== 'jnlm' && options.type !== 'oidn' && options.type !== 'custom')) throw new Error('Denoiser type must be jnlm, oidn or custom.');
  const allowed = options.type === 'jnlm'
    ? ['type', 'schedule', ...Object.keys(DEFAULT_JNLM_OPTIONS)]
    : options.type === 'custom' ? ['type', 'schedule', 'denoiser', 'aovs']
    : ['type', 'schedule', 'model', 'weightsBaseUrl', 'weightsUrl', 'aux', 'hdr', 'hdrTransfer', 'auxiliaryModelUrls', 'engine', 'precision', 'dynamicTile', 'maxTileSize', 'signal'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Denoiser field ${key} does not belong to ${options.type}.`);
  if (options.schedule !== undefined && !['converged', 'progressive', 'every-sample'].includes(options.schedule)) throw new Error('Unknown denoise schedule.');
  if (options.type === 'jnlm') createJNLMDenoiser(options);
  else if (options.type === 'custom') {
    aovMask(options.aovs ?? []);
    if (!options.denoiser || typeof options.denoiser !== 'object' || typeof options.denoiser.denoise !== 'function' || (options.denoiser.prepare !== undefined && typeof options.denoiser.prepare !== 'function')) throw new Error('Custom denoiser must implement denoise and optional prepare.');
  } else {
    if (options.weightsUrl !== undefined) {
      if (options.model !== undefined || options.weightsBaseUrl !== undefined) throw new Error('weightsUrl is mutually exclusive with model and weightsBaseUrl.');
    } else if (options.aux !== undefined || options.hdr !== undefined || options.hdrTransfer !== undefined) throw new Error('aux, hdr and hdrTransfer require weightsUrl.');
    for (const key of ['weightsUrl', 'weightsBaseUrl'] as const) if (options[key] !== undefined && !isURL(options[key])) throw new Error(`${key} must be a nonempty string or URL.`);
    if (options.auxiliaryModelUrls !== undefined) {
      const urls = options.auxiliaryModelUrls;
      if (!urls || !isURL(urls.albedo) || !isURL(urls.normal) || Object.keys(urls).some(key => !['albedo', 'normal'].includes(key))) throw new Error('auxiliaryModelUrls requires only albedo and normal URLs.');
    }
    for (const [key, values] of [['engine', ['auto', 'wgsl', 'webnn']], ['precision', ['auto', 'fp32', 'fp16']], ['hdrTransfer', ['pu', 'log']]] as const) {
      if (options[key] !== undefined && !(values as readonly string[]).includes(options[key]!)) throw new Error(`Unknown OIDN ${key}.`);
    }
    for (const key of ['aux', 'hdr'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
    if (options.dynamicTile !== undefined && typeof options.dynamicTile !== 'boolean') {
      if (!options.dynamicTile || typeof options.dynamicTile !== 'object') throw new Error('dynamicTile must be boolean or tile settings.');
      for (const [key, value] of Object.entries(options.dynamicTile)) {
        if (!['minTileSize', 'initialTileSize', 'targetTileTimeMs', 'adjustmentStep'].includes(key) || (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))) throw new Error(`Invalid dynamicTile ${key}.`);
      }
    }
    if (options.model !== undefined && !['standard', 'small', 'cleanAuxLarge'].includes(options.model)) throw new Error('Unknown OIDN model.');
    if (options.maxTileSize !== undefined && (!Number.isInteger(options.maxTileSize) || options.maxTileSize < 1)) throw new Error('maxTileSize must be a positive integer.');
  }
}

function isURL(value: unknown): value is string | URL { return (typeof value === 'string' && value.length > 0) || value instanceof URL; }

// Snapshot nested values too, so application edits cannot silently change a cache key.
function snapshotDenoiserOptions(options: DenoiserOptions): Readonly<DenoiserOptions> {
  if (options.type === 'custom') return Object.freeze({...options,aovs:Object.freeze([...(options.aovs ?? [])])});
  if (options.type !== 'oidn') return Object.freeze({...options});
  const next: OIDNDenoiserOptions = {...options};
  if (options.weightsBaseUrl !== undefined) next.weightsBaseUrl = String(options.weightsBaseUrl);
  if (options.weightsUrl !== undefined) next.weightsUrl = String(options.weightsUrl);
  if (options.auxiliaryModelUrls !== undefined) next.auxiliaryModelUrls = Object.freeze({albedo: String(options.auxiliaryModelUrls.albedo), normal: String(options.auxiliaryModelUrls.normal)});
  if (typeof options.dynamicTile === 'object') next.dynamicTile = Object.freeze({...options.dynamicTile});
  return Object.freeze(next);
}

function denoiserKey(options: Readonly<DenoiserOptions>): string | Denoiser {
  if (options.type === 'custom') return options.denoiser;
  if (options.type === 'jnlm') return JSON.stringify({type: 'jnlm', ...Object.fromEntries(Object.entries(DEFAULT_JNLM_OPTIONS).map(([key, value]) => [key, options[key as keyof JNLMOptions] ?? value]))});
  const tile = options.dynamicTile;
  return JSON.stringify({type: 'oidn',
    ...(options.weightsUrl === undefined ? {model: options.model ?? 'standard', weightsBaseUrl: options.weightsBaseUrl?.toString()} : {weightsUrl: String(options.weightsUrl), aux: options.aux ?? true, hdr: options.hdr ?? true, hdrTransfer: options.hdrTransfer ?? 'pu'}),
    auxiliaryModelUrls: options.auxiliaryModelUrls && {albedo: String(options.auxiliaryModelUrls.albedo), normal: String(options.auxiliaryModelUrls.normal)},
    maxTileSize: options.maxTileSize, engine: options.engine ?? 'auto', precision: options.precision ?? 'auto',
    dynamicTile: tile === false ? false : {minTileSize: typeof tile === 'object' ? tile.minTileSize ?? 256 : 256,
      initialTileSize: typeof tile === 'object' ? tile.initialTileSize ?? 432 : 432,
      targetTileTimeMs: typeof tile === 'object' ? tile.targetTileTimeMs ?? 16 : 16,
      adjustmentStep: typeof tile === 'object' ? tile.adjustmentStep ?? 16 : 16}
  });
}

/** One independently configured image and its accumulation, owned by an engine. */
export default class Render {
  /** Enabled surface outputs. Default []; readPixels rejects outputs not enabled here. */ aovs: readonly AovKind[] = [];
  /** Independent AOV sample cap. Default 16. */ aovSamples = 16;
  /** Maximum complete samples. Default 2048. */ maxSamples = 2048;
  /**
   * Maximum scattering depth, rounded and clamped to [1, 20] (NaN becomes 1).
   * Total path events, including transmission and alpha skips, are capped at 20
   * and at three times this depth. Intel Mac WebGL uses min(depth, 3), doubled
   * for scenes with transmission or alpha, with its existing early termination.
   * Default 3.
   */ bounces = 3;
  /** Per-sample radiance clamp; 0 disables it. Default 0. */ clamping = 0;
  /** Sampling sequence. Default sobol. */ samplingPattern: SamplingPattern = 'sobol';
  /** Caustic estimators. Default undefined (all disabled). */ caustics?: CausticSettings;
  /** WebGPU light candidates per vertex; ignored on WebGL. Default 4. */ directLightCandidates = 4;
  /** Rounded material edges. Default true. */ bevel = true;
  /** Bevel probes, clamped to 1–32. Default 8. */ bevelSamples = 8;
  /** Dispersion wavelengths per sample. Default 3. */ dispersionWavelengths: 1 | 3 = 3;
  /** WebGPU primary-ray alpha policy; ignored on WebGL. Default stochastic. */ alphaBlendStrategy: AlphaBlendStrategy = 'stochastic';
  /** Minimum transmissive path alpha. Default 1. Changing it restarts this render. */ transmissiveOutputAlphaMin = 1;
  /** Execution budget in milliseconds. Default 21. */ timeBudgetMs = 21;
  /** Maximum tiles per frame. Default Infinity. */ maxTiles = Infinity;
  /** Let one refine submit several samples within timeBudgetMs; WebGPU requires GPU timestamps. Default false. */ batchSamples = false;
  /** @deprecated Use batchSamples; this alias will be removed in a later release. Default false. */
  get allowMultipleSamplesPerFrame(): boolean { return this.batchSamples; }
  set allowMultipleSamplesPerFrame(value: boolean) { this.batchSamples = value; }
  /** Adaptive resolution controller, or false. Default false. */ adaptiveResolution: {targetFrameMs: number; minScale: number} | false = false;
  private _resolutionScale = 1;
  /** Canvas-relative scale. Default 1; cannot be assigned on a fixed-size render. */
  get resolutionScale() { return this._resolutionScale; }
  set resolutionScale(value: number) {
    if (this._fixed) throw new Error('Fixed-size renders cannot use resolutionScale.');
    if (!Number.isFinite(value) || value <= 0) throw new Error('resolutionScale must be positive.');
    if (value !== this._resolutionScale) this._cancelAdaptiveFrames();
    this._resolutionScale = value;
  }
  private _fallback: Render | null = null;
  /** Single-level fallback on this engine. Default null; chains and cycles are rejected. */
  get fallback() { return this._fallback; }
  set fallback(value: Render | null) {
    if (value && (value._engine !== this._engine || value === this || value.fallback)) throw new Error('Fallback must be a render on the same engine with no fallback.');
    if (value && this._dependents.size) throw new Error('Fallback renders cannot have their own fallback.');
    this._fallback?._dependents.delete(this);
    this._fallback = value; value?._dependents.add(this);
  }
  private _dependents = new Set<Render>();
  private _denoiserOptions: Readonly<DenoiserOptions> | null = null;
  /** Frozen configuration snapshot. Default null. Change it with {@link Render.setDenoiser}. */
  get denoiser(): Readonly<DenoiserOptions> | null { return this._denoiserOptions; }
  /**
   * Replaces the denoising configuration; null disables denoising. Invalid options throw synchronously
   * before replacing any state. Resolves when the filter is ready to use (after OIDN weights load) or this
   * configuration is replaced; rejects when loading fails. An equal configuration returns the current
   * promise without reloading.
   */
  setDenoiser(options: DenoiserOptions | null): Promise<void> {
    if (options !== null) validateDenoiserOptions(options);
    const next = options ? snapshotDenoiserOptions(options) : null;
    const current = this._denoiserOptions;
    if (current === null && next === null) return this._denoiserReady;
    if (next && current && denoiserKey(next) === denoiserKey(current)
      && (next.type !== 'custom' || current.type === 'custom' && aovMask(next.aovs ?? [])===aovMask(current.aovs ?? []))
      && next.schedule === current.schedule && (next.type !== 'oidn' ||
        (current.type === 'oidn' && next.signal === current.signal))) return this._denoiserReady;
    this._denoiserOptions = next;
    return this._refreshDenoiser() ?? this._denoiserReady;
  }
  private _denoiserReady: Promise<void> = Promise.resolve();
  private _fixed?: {width: number; height: number};
  private _target?: RenderTarget;
  private _status: RenderStatus = 'preparing';
  private _disposed = false;
  private _busy = false;
  private _refineOptions?: RefineOptions;
  private _offlineCamera = false;
  private _input = {scene: -1, camera: -1, settings: ''};
  private _adaptiveScale = 1;
  private _lastScale = 1;
  private _frameTime = 0;
  private _sampleStart?: number;
  private _frameStart?: number;
  private _sampleScale = 1;
  private _frameScale = 1;
  private _adaptiveFrames = new Set<() => void>();
  private _adaptiveFastFrames = 0;
  private _events = new Events<{sample: SampleEvent}>();
  /** Owning engine. */ get engine(): Engine { return this._engine; }
  /** Whether inference is queued or running, including intermediate updates. Default false. */ get denoising(): boolean { return !!this._denoisePending; }
  /** Subscribes to every complete sample on this render; returns unsubscribe. */
  on(event: 'sample', listener: (value: SampleEvent) => void): () => void { return this._events.on(event, listener); }
  private _filter?: OwnedDenoiser | Extract<DenoiserHandle, {kind: 'custom'}>;
  private _filterKey: string | Denoiser = '';
  private _warnedWebGPUFilter = false;
  private _denoiseController?: AbortController;
  private _filterRevision = 0;
  private _filterPending?: Promise<void>;
  private _denoiseRevision = 0;
  private _denoisePending?: Promise<void>;
  private _denoisedSamples = 0;
  private _lastDenoiseTime = 0;
  private _warnedDenoisedReadback = false;
  /** @internal */ readonly _engine: Engine;

  constructor(engine: Engine, options: RenderOptions = {}) {
    this._engine = engine;
    if (options.denoiser != null) validateDenoiserOptions(options.denoiser);
    if ('width' in options || 'height' in options) {
      if ('resolutionScale' in options || !Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width! < 1 || options.height! < 1) throw new Error('Provide positive integer width and height, or resolutionScale, exclusively.');
      this._fixed = {width: options.width!, height: options.height!};
    }
    const {width: _width, height: _height, resolutionScale, fallback, denoiser, allowMultipleSamplesPerFrame, ...settings} = options;
    Object.assign(this, settings);
    if (settings.batchSamples === undefined && allowMultipleSamplesPerFrame !== undefined) this.batchSamples = allowMultipleSamplesPerFrame;
    if (resolutionScale !== undefined) this.resolutionScale = resolutionScale;
    this._adaptiveScale = this._resolutionScale; this._lastScale = this._resolutionScale;
    this._validate(); this.fallback = fallback ?? null;
    engine._register(this);
    if (denoiser) void this.setDenoiser(denoiser).catch(error => this._engine._notifyError(error));
  }
  /** Actual target width; before allocation uses the requested dimensions. */ get width() { return this._target?.getMemory().width || this._size().width; }
  /** Actual target height; before allocation uses the requested dimensions. */ get height() { return this._target?.getMemory().height || this._size().height; }
  /** Complete beauty samples since the last restart; stale engine inputs report 0. Default 0. */
  get samples() { return this._current ? this._target?.getTotalSamplesRendered() ?? 0 : 0; }
  /** Whether complete beauty samples reached maxSamples. Default false. */ get converged() { return this.samples >= this.maxSamples; }
  /** Current execution state. Default preparing. */ get status(): RenderStatus {
    if (!this._current && this._status !== 'error') return this._engine._ready ? 'converging' : 'preparing';
    return this._status;
  }
  private get _current() { const inputs = this._engine._inputs; return inputs.scene === this._input.scene && inputs.camera === this._input.camera && !this._disposed; }
  /** @internal */ get _complete() { return this._current && !!this._target?.presentationComplete && !this._target.isFirstFrame() && this.samples > 0; }
  /** @internal */ get _presentable() { return this._complete && (!this._denoisePending || this._denoisedSamples > 0 || (this._schedule() === 'converged' && this.maxSamples > 1)); }
  /** @internal */ get _output() { if (this._disposed) throw new Error('Render is disposed.'); return this._target; }
  /** Latest WebGPU full beauty sample estimate in milliseconds. Default undefined; also undefined for stale inputs, during converge or without GPU timestamps. */
  get gpuSampleTimeMs(): number | undefined { return !this._busy && this._current ? this._target?.getRealtimeSampleTime?.() : undefined; }
  /** Waits for the next release of WebGPU sampling queue capacity. Resolves immediately if no sampling is queued or on WebGL; does not submit work. Throws after disposal. */
  whenReadyToRefine(): Promise<void> {
    if (this._disposed) throw new Error('Render is disposed.');
    return this._target?.whenTraceAvailable?.() ?? Promise.resolve();
  }
  /** Complete surface-output samples since restart; stale inputs report 0. Independent of beauty samples. Default 0. */
  get aovSamplesRendered(): number { return this._current ? this._target?.getAovSamples?.() ?? 0 : 0; }
  /** @internal */
  _completeFor(channel: DisplayChannel): boolean {
    const kind = displayAovKind(channel);
    return kind && this.aovs.includes(kind) && this._target?.aovReady
      ? this._current && this._target.aovReady(kind) : this._complete;
  }
  /** @internal */
  _restartAovs(): void {
    this._target?.activate(); this._target?.restartAovs?.();
    this._status = 'converging';
  }
  private _refineAov(kind: AovKind): RenderStatus {
    if (this._engine._initializationError) throw this._engine._initializationError;
    if (!this.aovs.includes(kind)) throw new Error(`AOV ${kind} is not enabled`);
    if (!this._engine._ready) {
      const generation = this._engine._deviceGeneration;
      void this._engine.init().catch(error => {
        if (this._disposed || generation !== this._engine._deviceGeneration) return;
        this._status = 'error'; this._engine._notifyError(error);
      });
      return this._status = 'preparing';
    }
    const started = performance.now();
    const target = this._synchronize();
    if (!target) return this._status = 'preparing';
    const before = target.getAovSamples?.() ?? 0;
    const limit = kind === 'id' || kind === 'motion' ? 1 : Math.min(this.maxSamples, this.aovSamples);
    if (!target.refineAovs?.(this._engine._inputs.value!, Math.min(limit, (target.getAovSamples?.() ?? 0) + 1))) return this._status = 'compiling';
    if ((target.getAovSamples?.() ?? 0) > before) {
      this._frameTime = Math.max(.001, performance.now() - started);
      this._frameStart = started; this._frameScale = this._adaptiveScale;
      this._adaptResolution(true);
    }
    return this._status = (target.getAovSamples?.() ?? 0) >= limit ? 'finished' : 'converging';
  }
  private _validate() {
    aovMask(this.aovs);
    if (!Number.isInteger(this.aovSamples) || this.aovSamples < 1) throw new Error('aovSamples must be a positive integer.');
    if (!Number.isFinite(this.maxSamples) || this.maxSamples < 1) throw new Error('maxSamples must be positive.');
    if (this.dispersionWavelengths !== 1 && this.dispersionWavelengths !== 3) throw new Error('dispersionWavelengths must be 1 or 3.');
    const adaptive = this.adaptiveResolution;
    if (adaptive && (this._fixed || !Number.isFinite(adaptive.targetFrameMs) || adaptive.targetFrameMs <= 0 || !Number.isFinite(adaptive.minScale) || adaptive.minScale <= 0 || adaptive.minScale > this._resolutionScale)) throw new Error('adaptiveResolution requires a scale-based render with positive targetFrameMs and minScale <= resolutionScale.');
  }
  private _size() {
    if (this._fixed) return this._fixed;
    const scale = this.adaptiveResolution ? Math.min(this._adaptiveScale, this._resolutionScale) : this._resolutionScale;
    return {width: Math.max(1, Math.round(this._engine.display.canvas.width * scale)), height: Math.max(1, Math.round(this._engine.display.canvas.height * scale))};
  }
  private _settings(sampleCap = this.maxSamples): TraceSettings {
    const settings=collectTraceSettings(this,sampleCap);
    settings.batchSamples = this._refineOptions?.batchSamples ?? settings.batchSamples;
    if(this._denoiserOptions?.type==='custom') settings.aovs=[...new Set([...this.aovs,...(this._denoiserOptions.aovs ?? [])])];
    return settings;
  }
  private _synchronize(sampleCap = this.maxSamples, offline = false) {
    this._validate();
    if (this._lastScale !== this._resolutionScale) { this._adaptiveScale = this._resolutionScale; this._lastScale = this._resolutionScale; }
    const target = this._target ??= this._engine._createTarget();
    if (!target) return;
    const settings = this._settings(sampleCap), size = this._size();
    const key = imageSettingsKey(settings, size);
    const inputs = this._engine._inputs;
    target.configure(settings); target.activate();
    target.setRealtimeBatchBudget?.(this._refineOptions?.targetBatchTimeMs ?? Infinity);
    target.setRealtimeDeferPostProcess?.(!!this._refineOptions?.deferResolve);
    if ((!offline && this._offlineCamera) || inputs.scene !== this._input.scene || inputs.camera !== this._input.camera || key !== this._input.settings) {
      if (!offline) this._offlineCamera = false;
      this._cancelDenoise(); target.restartSamples();
      this._sampleStart = this._frameStart = undefined; this._frameTime = 0;
      target.setSize(size.width, size.height);
      this._input = {scene: inputs.scene, camera: inputs.camera, settings: key};
    }
    target.setOnSampleRendered((samples, isFirstFrame, frameTimeMs) => {
      // A preview's latency includes every tile, not just its last dispatch.
      this._frameTime = Math.max(frameTimeMs, this._sampleStart === undefined ? 0 : performance.now() - this._sampleStart);
      this._frameStart = this._sampleStart;
      this._frameScale = this._sampleScale;
      this._sampleStart = undefined;
      this._events.emit('sample', {samples, isFirstFrame, frameTimeMs});
    });
    return target;
  }
  private _trace(target: RenderTarget, limit: number) {
    if (this._sampleStart === undefined) { this._sampleStart = performance.now(); this._sampleScale = this._adaptiveScale; }
    const compiling = target.trace(this._engine._inputs.value!, limit);
    if (compiling) this._sampleStart = undefined;
    return compiling;
  }
  private _adaptResolution(surfaceOnly = false) {
    if (!this._busy && this.adaptiveResolution && this._frameTime > 0 && (surfaceOnly ? this.aovSamplesRendered > 0 : this.samples > 0)) {
      const {targetFrameMs, minScale} = this.adaptiveResolution;
      const start = this._frameStart, time = this._frameTime, scale = this._frameScale, maxScale = this._resolutionScale;
      const {width, height} = this._engine.display.canvas;
      this._frameTime = 0;
      // Observe the following display frame too: GPU submissions and WebGL
      // filters can return long before their work reaches the screen.
      const cancel = scheduleFrame(() => {
        this._adaptiveFrames.delete(cancel);
        const adaptive = this.adaptiveResolution, canvas = this._engine.display.canvas;
        if (this._disposed || this._busy || !adaptive || adaptive.targetFrameMs !== targetFrameMs || adaptive.minScale !== minScale ||
          this._resolutionScale !== maxScale || canvas.width !== width || canvas.height !== height) return;
        const elapsed = Math.max(time, start === undefined ? 0 : performance.now() - start);
        const next = nextPreviewScale(scale, elapsed, targetFrameMs, maxScale, this._adaptiveScale, minScale);
        if (next > this._adaptiveScale) {
          if (++this._adaptiveFastFrames < 4) return;
          this._adaptiveScale = Math.min(next, this._adaptiveScale * 1.25);
        } else this._adaptiveScale = next;
        this._adaptiveFastFrames = 0;
      });
      this._adaptiveFrames.add(cancel);
    }
  }
  private _cancelAdaptiveFrames() {
    for (const cancel of this._adaptiveFrames) cancel();
    this._adaptiveFrames.clear(); this._adaptiveFastFrames = 0;
  }
  /** Accumulates within this frame's budget. Default undefined traces beauty and requested AOVs. Pass an enabled AOV kind to refine surface outputs only, without beauty or denoising; progress is aovSamplesRendered. Options default to this render's execution settings. Rejects calls during converge or after disposal. */
  refine(channel?: AovKind, options?: RefineOptions): RenderStatus {
    if (this._busy) throw new Error('Cannot refine a render while converge is running.');
    if (this._disposed) throw new Error('Render is disposed.');
    this._engine._setRenderError();
    const previous = this._refineOptions; this._refineOptions = options;
    try {
      if (options?.targetBatchTimeMs !== undefined && (!Number.isFinite(options.targetBatchTimeMs) || options.targetBatchTimeMs <= 0)) throw new RangeError('targetBatchTimeMs must be positive and finite.');
      return channel === undefined ? this._refine() : this._refineAov(channel);
    }
    catch (error) { this._engine._setRenderError(this._engine._notifyError(error)); return this._status = 'error'; }
    finally { this._refineOptions = previous; this._engine._reportShaderProgress(); }
  }
  private _refine(): RenderStatus {
    if (this._engine._initializationError) throw this._engine._initializationError;
    this._reloadDenoiser();
    if (!this._engine._ready) {
      const generation = this._engine._deviceGeneration;
      void this._engine.init().catch(error => {
        if (this._disposed || generation !== this._engine._deviceGeneration) return;
        this._status = 'error'; this._engine._notifyError(error);
      });
      return this._status = 'preparing';
    }
    const target = this._synchronize();
    if (!target) return this._status = 'preparing';
    if (this._fallback && this.samples === 0 && !target.canCompleteSampleWithin(this.timeBudgetMs) && !this._fallback._complete) this._fallback._refineOne();
    target.activate();
    if (this._denoisePending) return this._status = this.converged ? 'denoising' : 'converging';
    target.setPreserveDenoisedOutput?.(!!this._filter && this._schedule() !== 'converged');
    const limit = this._nextSampleTarget();
    if (this.samples < limit) {
      if (this._trace(target, limit)) return this._status = 'compiling';
    } else if (target.refineAovs && !target.refineAovs(this._engine._inputs.value!)) {
      return this._status = 'compiling';
    }
    this._maybeDenoise(false, limit);
    if (this._denoisePending) return this._status = this.converged ? 'denoising' : 'converging';
    if (this._filterPending && this.converged) return this._status = 'preparing';
    this._adaptResolution();
    return this._status = this.converged ? 'finished' : 'converging';
  }
  private _refineOne() {
    if (this._busy || this._disposed || !this._engine._ready) return;
    this._reloadDenoiser(); const target = this._synchronize();
    if (!target) return;
    target.activate();
    if (this.samples < 1) this._status = this._trace(target, 1) ? 'compiling' : 'converging';
    this._maybeDenoise();
    if (!this._denoisePending) this._adaptResolution();
  }
  private _schedule() { return this._denoiserOptions?.schedule ?? 'converged'; }
  private _nextSampleTarget() {
    if (!this._filter) return this.maxSamples;
    if (this._schedule() === 'every-sample') return Math.min(this.maxSamples, this.samples + 1);
    if (this._schedule() === 'converged') return this.maxSamples;
    if (this._denoisedSamples === 0) return 1;
    const sinceUpdate = performance.now() - this._lastDenoiseTime;
    if (sinceUpdate >= 10000) return Math.min(this.maxSamples, this.samples + 1);
    // Batched sampling doubles the count within a few frames. Without a floor,
    // most filtering would go to images replaced almost at once.
    if (sinceUpdate < 500) return this.maxSamples;
    return Math.min(this.maxSamples, Math.max(4, this._denoisedSamples * 2));
  }
  /** Reloads a filter dropped by device recovery; failures report through engine errors. */
  private _reloadDenoiser() { void this._refreshDenoiser()?.catch(error => this._engine._notifyError(error)); }
  /** Starts loading the configured filter; returns its readiness when a new configuration was applied. */
  private _refreshDenoiser(): Promise<void> | undefined {
    if (this._disposed) return;
    const options = this._denoiserOptions;
    const key = options ? denoiserKey(options) : '';
    if (key === this._filterKey) return;
    this._filterKey = key; const revision = ++this._filterRevision;
    this._cancelDenoise();
    if (this._filter && this._filter.kind !== 'custom') this._engine._releaseDenoiser(this._filter);
    this._target?.invalidateDenoisedOutput();
    this._filter = undefined; this._filterPending = undefined;
    if (!options) return this._denoiserReady = Promise.resolve();
    if (options.type === 'jnlm') { this._filter = this._engine._retainDenoiser(`jnlm:${key}`, () => ({kind: 'jnlm', denoiser: createJNLMDenoiser(options)})); return this._denoiserReady = Promise.resolve(); }
    const task = (async () => {
      await this._engine.init();
      if (this._engine.backend !== 'webgpu') { if (revision === this._filterRevision && !this._warnedWebGPUFilter) { this._warnedWebGPUFilter = true; console.warn('This denoiser requires WebGPU; denoising is disabled for this render.'); } return; }
      if (revision !== this._filterRevision || this._disposed) return;
      if (options.type === 'custom') { this._filter = {kind: 'custom', denoiser: options.denoiser, aovs: options.aovs}; return; }
      const {loadOIDNNetwork} = await loadOIDN();
      const filter = await this._engine._acquireDenoiser(key as string, async () => ({kind: 'oidn', denoiser: await loadOIDNNetwork(this._engine, options)}));
      if (revision !== this._filterRevision || this._disposed) { this._engine._releaseDenoiser(filter); return; }
      this._filter = filter; this._warmDenoiser();
    })();
    this._filterPending = task;
    // Superseded or disposed loads resolve instead of reporting obsolete failures.
    return this._denoiserReady = task.catch(error => { if (revision === this._filterRevision && !this._disposed) throw error; })
      .finally(() => { if (this._filterPending === task) this._filterPending = undefined; });
  }
  private _warmDenoiser() {
    const filter = this._filter, revision = this._filterRevision;
    if (!filter || filter.kind !== 'oidn') return;
    const network = filter.denoiser;
    const filters = [network, network.auxiliaryDenoisers?.albedo, network.auxiliaryDenoisers?.normal];
    const width = this.width, height = this.height;
    const task = this._engine._enqueueDenoise(async () => {
      if (revision !== this._filterRevision || filter !== this._filter || this._disposed) return;
      await Promise.all(filters.map(network => network?.prepareForImage?.(width, height, {tileOverlap: this._schedule() === 'converged' ? undefined : 80})));
    });
    void task.catch(error => {
      if (revision === this._filterRevision && filter === this._filter && !this._disposed) this._engine._notifyError(error);
    });
  }

  private _cancelDenoise() { this._denoiseController?.abort(); this._denoiseController = undefined; this._denoiseRevision++; this._target?.cancelDenoise?.(); this._denoisePending = undefined; this._denoisedSamples = 0; }
  /** @internal */ _inputsChanged(resetTiming = false) { this._cancelDenoise(); if (resetTiming) this._target?.invalidateTiming?.(); }
  /** @internal */ _deviceLost(recovering: boolean) {
    this._cancelAdaptiveFrames();
    this._cancelDenoise(); this._filterRevision++;
    this._filter = undefined; this._filterPending = undefined; this._filterKey = '';
    this._target = undefined; this._input = {scene: -1, camera: -1, settings: ''};
    this._status = recovering ? 'preparing' : 'error';
  }
  /** @internal */ _displayChanged() { this._cancelDenoise(); this._target?.invalidateDenoisedOutput(); }
  private _maybeDenoise(force = false, sampleTarget = this._nextSampleTarget()) {
    const target = this._target, filter = this._filter;
    if (!target || !filter || this._denoisePending || this.samples < 1 || this._denoisedSamples === this.samples) return;
    if (!force && this._schedule() === 'converged' && !this.converged) return;
    if (!force && this._schedule() === 'progressive' && this.samples < sampleTarget) return;
    this._engine.display._configure(this);
    target.activate(); target.drawPostProcess();
    const revision = ++this._denoiseRevision, samples = this.samples, frameStart = this._frameStart;
    const controller = this._denoiseController = new AbortController();
    // One shared scratch lease across all renders; queued stale jobs do no GPU work.
    const task = this._engine._enqueueDenoise(async () => {
      if (revision !== this._denoiseRevision || this._disposed) return;
      target.activate(); this._engine.display._configure(this);
      if (revision !== this._denoiseRevision || this._disposed) return;
      target.drawPostProcess();
      if (filter.kind === 'custom') {
        await this._engine._prepareCustomDenoiser(filter.denoiser, this.width, this.height);
        if (controller.signal.aborted || revision !== this._denoiseRevision || this._disposed) return;
      }
      const complete = await target.performDenoise?.(filter, undefined, this._schedule(), controller.signal);
      if (revision !== this._denoiseRevision || this._disposed) return;
      if (complete) {
        target.activate(); target.drawPostProcess(); this._denoisedSamples = samples; this._lastDenoiseTime = performance.now();
        if (frameStart !== undefined) this._frameTime = Math.max(this._frameTime, this._lastDenoiseTime - frameStart);
      }
    });
    this._denoisePending = task;
    void task.catch(error => { if (revision === this._denoiseRevision && !this._disposed) this._engine._notifyError(error); }).finally(() => {
      if (this._denoisePending === task) {
        this._denoiseController = undefined; this._denoisePending = undefined;
        this._status = this.converged ? 'finished' : 'converging'; this._adaptResolution();
      }
    });
  }
  /** Reads native RGBA, top row first; id uses uint32, other kinds float32. Default hdr. Beauty/guide reads are empty until a beauty sample completes. AOV reads require explicit aovs enablement. Custom denoised output is resolved linear HDR ray color before display background/catcher composition; built-ins retain their native display-space output. Unavailable denoised output falls back to hdr. */
  readPixels(kind: 'id'): Promise<{width: number; height: number; data: Uint32Array}>;
  readPixels(kind?: 'hdr' | 'denoised' | 'albedo' | 'normal' | Exclude<AovKind, 'id'>): Promise<{width: number; height: number; data: Float32Array}>;
  readPixels(kind: 'hdr' | 'denoised' | 'albedo' | 'normal' | AovKind): Promise<{width: number; height: number; data: Float32Array | Uint32Array}>;
  async readPixels(kind: 'hdr' | 'denoised' | 'albedo' | 'normal' | AovKind = 'hdr'): Promise<{width: number; height: number; data: Float32Array | Uint32Array}> {
    if (this._disposed) throw new Error('Render is disposed.');
    const target = this._target;
    if (['depth', 'position', 'roughness', 'diffuseAlbedo', 'specularAlbedo', 'id', 'motion'].includes(kind)) {
      const aov = kind as AovKind;
      aovMask(this.aovs);
      if (!this.aovs.includes(aov)) throw new Error(`AOV ${aov} is not enabled`);
      if (!target?.readAov) throw new Error('AOV output is not ready');
      target.activate(); return target.readAov(aov);
    }
    if (!target || this.samples === 0) return {width: 0, height: 0, data: new Float32Array(0)};
    if (kind === 'denoised' && this._denoisedSamples === 0) {
      if (!this._warnedDenoisedReadback) { this._warnedDenoisedReadback = true; console.warn('Denoised output is not ready; reading HDR samples instead.'); }
      kind = 'hdr';
    }
    target.activate(); return target.readOutput(kind as 'hdr' | 'denoised' | 'albedo' | 'normal');
  }
  /** Borrows a read-only WebGPU texture; undefined on WebGL or before a complete sample. Kind is required. HDR is native resolved linear ray color before denoising/display composition, with DenoiseInput.color normalization and coverage. Display is the latest compose, including filters and display passes. Valid only until this render's next refine/converge, display present/setSize, restart/dispose or device loss; never retain, write or destroy it. */
  getOutputTexture(kind: 'hdr' | 'display'): GPUTexture | undefined {
    if (this._engine.backend !== 'webgpu' || (kind === 'hdr' ? !this._complete : !this._current || !this._target?.presentationComplete || (!this._complete && !this._target.getAovSamples?.()))) return;
    return this._target?.getOutputTexture?.(kind);
  }
  /** Discards only this render's accumulation and pending denoising. */
  restart() { if (this._disposed) throw new Error('Render is disposed.'); this._cancelDenoise(); this._cancelAdaptiveFrames(); this._sampleStart = this._frameStart = undefined; this._frameTime = 0; this._target?.restartSamples(); this._status = 'converging'; }
  /** Releases only this render's image resources and denoiser. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true; this._events.clear(); this._filterRevision++; this._cancelDenoise(); this._cancelAdaptiveFrames();
    if (this._target) this._engine._releaseTarget(this._target);
    if (this._filter && this._filter.kind !== 'custom') this._engine._releaseDenoiser(this._filter);
    this._target = undefined; this._filter = undefined; this._engine._unregister(this);
    this._fallback?._dependents.delete(this);
    for (const dependent of this._dependents) dependent._fallback = null;
    this._dependents.clear();
  }
  /** Deterministically renders this image. Rejects on abort/timeout/input revision changes and blocks refine on this render. */
  async converge(options: ConvergeOptions): Promise<ConvergeResult> {
    if (this._busy) throw new Error('Converge is already running on this render.');
    if (this._disposed) throw new Error('Render is disposed.');
    const inputs = this._engine._inputs;
    const deviceGeneration = this._engine._deviceGeneration;
    if (!inputs.value) throw new Error('Commit engine.scene and engine.camera with engine.update() before converge.');
    const camera = cameraSnapshot(options.camera ?? inputs.value);
    const samples = Math.max(1, Math.round(options.samples));
    if (!Number.isFinite(samples)) throw new Error('samples must be finite and positive.');
    const batchLimit = Math.max(1, Math.round(options.samplesPerBatch ?? 8));
    const sequenceOffset = Math.max(0, Math.round(options.sampleSequenceOffset ?? 0));
    const timeout = Math.max(1, options.timeoutMs ?? 600000);
    const check = () => {
      if (this._disposed) throw new Error('Render is disposed.');
      if (this._engine._deviceGeneration !== deviceGeneration) throw this._engine._lostError;
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Convergence aborted', 'AbortError');
      const current = this._engine._inputs;
      if (current.scene !== inputs.scene || current.camera !== inputs.camera) throw new Error('Engine inputs changed during converge.');
    };
    this._busy = true;
    const abortConverge = () => this._cancelDenoise();
    options.signal?.addEventListener('abort', abortConverge, {once: true});
    let target: RenderTarget | undefined;
    const start = performance.now();
    try {
      await this._engine._awaitDevice(this._engine.init());
      check();
      while (!this._engine._ready) { check(); if (performance.now() - start > timeout) throw new Error('Timed out preparing convergence.'); await new Promise(resolve => setTimeout(resolve, 0)); }
      target = this._synchronize(samples, true);
      this._offlineCamera = !!options.camera;
      if (!target) throw new Error('The render target is not ready.');
      this._cancelDenoise(); target.restartSamples();
      this._reloadDenoiser(); await this._engine._awaitDevice(Promise.resolve(this._filterPending)); check();
      const stage = async (cap: number, name: 'pilot' | 'final', offset: number) => {
        check(); this._cancelDenoise(); target!.activate(); target!.restartSamples();
        target!.configure({...this._settings(cap), batchSamples: true});
        let batch = options.targetBatchTimeMs && this._engine.device ? 1 : Math.min(batchLimit, cap);
        let previous = -1, lastPreview = performance.now(); const started = performance.now();
        for (;;) {
          check(); if (performance.now() - started > timeout) throw new Error(`Timed out rendering the offline ${name} pass.`);
          target!.activate(); target!.setOfflineRenderOptions({samplesPerBatch: batch, deferPostProcess: true, sampleSequenceOffset: offset});
          const before = target!.getTotalSamplesRendered(), batchStarted = performance.now();
          this._status = target!.trace(camera, cap) ? 'compiling' : 'converging';
          const count = target!.getTotalSamplesRendered();
          if (count !== previous) {
            previous = count; options.onProgress?.({stage: name, samples: Math.min(count, cap), targetSamples: cap});
            if (name === 'final' && options.previewIntervalMs !== undefined && count > 0 && count < cap && performance.now() - lastPreview >= options.previewIntervalMs) { target!.drawPostProcess(); lastPreview = performance.now(); }
          }
          if (count >= cap) break;
          if (count > before && this._engine.device) await this._engine._awaitDevice(this._engine.device.queue.onSubmittedWorkDone());
          else await new Promise(resolve => setTimeout(resolve, 0));
          if (options.targetBatchTimeMs && this._engine.device && count > before) {
            const desired = Math.max(1, Math.min(batchLimit, Math.round(options.targetBatchTimeMs * (count - before) / Math.max(1, performance.now() - batchStarted))));
            batch = desired > batch ? Math.min(desired, batch * 2) : desired;
          }
        }
        await this._engine._awaitDevice(Promise.resolve(this._engine.device?.queue.onSubmittedWorkDone())); check();
      };
      let result: ConvergeResult = {samples, averageSamplesPerPixel: samples, pilotSamples: 0, adaptiveSampling: false};
      if (options.adaptiveSampling && this._engine.device) {
        const pilotSamples = Math.min(samples, Math.max(2, Math.round(options.adaptiveSampling.pilotSamples ?? 8)));
        target.activate(); target.setVarianceMoments(true); target.setAdaptiveSamplingTargets(undefined);
        await stage(pilotSamples, 'pilot', sequenceOffset);
        target.activate(); const plan = await this._engine._awaitDevice(target.prepareOfflineAdaptiveSampling({...options.adaptiveSampling, maxSamples: samples}));
        if (plan) {
          target.activate(); target.setVarianceMoments(false);
          await stage(plan.maximumTarget, 'final', sequenceOffset + pilotSamples);
          result = {samples: plan.maximumTarget, averageSamplesPerPixel: plan.averageTarget, pilotSamples, varianceHistory: plan.history, adaptiveSampling: true};
        } else { target.setVarianceMoments(false); target.setAdaptiveSamplingTargets(undefined); await stage(samples, 'final', sequenceOffset); }
      } else { target.activate(); target.setVarianceMoments(false); target.setAdaptiveSamplingTargets(undefined); await stage(samples, 'final', sequenceOffset); }
      if (this._filter) {
        options.onProgress?.({stage: 'denoising', samples: result.samples, targetSamples: result.samples});
        this._status = 'denoising'; this._maybeDenoise(true); await this._engine._awaitDevice(Promise.resolve(this._denoisePending)); check();
      }
      this._status = 'finished'; return result;
    } catch (error) { if (this._engine._deviceGeneration === deviceGeneration) this._status = 'error'; throw error; }
    finally {
      if (target && !this._disposed && this._engine._deviceGeneration === deviceGeneration) { target.activate(); target.setVarianceMoments(false); target.setAdaptiveSamplingTargets(undefined); target.setOfflineRenderOptions({samplesPerBatch: 0, deferPostProcess: false, sampleSequenceOffset: 0}); }
      options.signal?.removeEventListener('abort', abortConverge);
      this._busy = false;
    }
  }
}
