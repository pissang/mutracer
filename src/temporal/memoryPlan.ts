import type {NormalizedTemporalOptions} from './options.js';

export interface TemporalMemoryPlan {
  readonly historyRadius: Readonly<{min: number; max: number}>;
  readonly postRadius: number;
  readonly bytes: number;
}

export interface TemporalMemoryLimits {
  readonly maxTextureDimension2D: number;
  readonly maxTextureArrayLayers: number;
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
}

const overflowBuckets = 4096;
const overflowEntryBytes = 32;
export const TEMPORAL_MAX_FINISHED = 4;
const ceilDiv = (value: number, divisor: number) => Math.ceil(value / divisor);

function slots(mode: NormalizedTemporalOptions['mode'], radius: number, offlineDiameter: boolean) {
  return mode === 'offline' && offlineDiameter ? radius * 2 + 1 : radius + 1;
}

/** Exact allocation estimate for the GPU resources owned by temporal history, window and post stages. */
export function estimateTemporalMemory(width: number, height: number, options: NormalizedTemporalOptions, materialCount=0) {
  const pixels = width * height;
  const historySlots = options.mode === 'offline' ? options.historyRadius.max * 2 + 1 : options.historyRadius.max + 1;
  const postSlots = options.postRadius > 0 ? slots(options.mode, options.postRadius, true) : 0;

  // TemporalGPU pre ring: 120 bytes per pixel per slot, camera and overflow
  // table per slot, plus per-frame working buffers and small counters.
  const pre = historySlots * (pixels * 120 + 80 + overflowBuckets * overflowEntryBytes) + pixels * 48 + 116;

  // DirectWindowGPU holds a 56-byte-per-pixel frame across its ring, two
  // per-frame sums, packed HDR overflow entries, camera records and uniforms.
  const window = historySlots * (pixels * 56 + 80 + overflowBuckets * overflowEntryBytes) + pixels * 32 + 128;

  const pyramidBytes = scales.reduce((sum, scale) => sum + ceilDiv(width, scale) * ceilDiv(height, scale) * 8, 0);
  const grids = gridScratchBytes(width, height);
  const post = postSlots ? postSlots * (pixels * 72 + pyramidBytes + 80) + pixels * 76 + grids + 152 : 0;
  const composition = pixels * 48 + ceilDiv(pixels, 64) * 4 + 16 + (options.stabilizeSparkle && options.postRadius > 0 ? 32 : 0);
  const queuedFrames = TEMPORAL_MAX_FINISHED * pixels * (options.denoiser?.type === 'oidn' ? 96 : 80);
  const postPending = options.mode === 'offline' ? options.postRadius : 0;
  const pendingAndTransient = pixels * (postPending + 2) * 16;
  const customAovs = options.denoiser?.type === 'custom' ? (options.mode === 'offline' ? options.historyRadius.max + 1 : 1) *
    (options.denoiser.aovs?.length ?? 0) * pixels * 16 : 0;
  const materialRevisionTable = Math.max(8, materialCount * 8);
  const changedMaterialIds = options.postRadius > 0 ? postSlots * Math.max(8, (materialCount + 1) * 4) : 0;
  return pre + window + post + composition + queuedFrames + pendingAndTransient + customAovs + materialRevisionTable + changedMaterialIds;
}

const scales = [2, 4, 8] as const;
function gridScratchBytes(width: number, height: number) {
  const grids = [...scales, ...scales, scales[0], scales[0]];
  return grids.reduce((sum, scale) => sum + ceilDiv(width, scale * 3) * ceilDiv(height, scale * 3) * 8, 0);
}

function layerLimits(width: number, height: number, options: NormalizedTemporalOptions, limits: TemporalMemoryLimits, materialCount: number) {
  if (width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) return false;
  const history = options.mode === 'offline' ? options.historyRadius.max * 2 + 1 : options.historyRadius.max + 1;
  const post = options.postRadius > 0 ? slots(options.mode, options.postRadius, true) : 0;
  if (history * 4 > limits.maxTextureArrayLayers || history * 2 > limits.maxTextureArrayLayers ||
      history > limits.maxTextureArrayLayers || post * 3 > limits.maxTextureArrayLayers || post > limits.maxTextureArrayLayers) return false;

  const pixels = width * height, image = pixels * 16;
  const overflow = history * overflowBuckets * overflowEntryBytes;
  const grids = [...scales, ...scales, scales[0], scales[0]].map(scale =>
    ceilDiv(width, scale * 3) * ceilDiv(height, scale * 3) * 8);
  const revisionTable = Math.max(8, materialCount * 8);
  const changedMaterialIds = options.postRadius > 0 ? post * Math.max(8, (materialCount + 1) * 4) : 0;
  const buffers = [image, overflow, history * 80, post * 80, image / 4, ceilDiv(pixels, 64) * 4, revisionTable, changedMaterialIds,
    ...(post ? grids : [])];
  return buffers.every(size => Number.isSafeInteger(size) &&
    size <= Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize));
}

function candidates(options: NormalizedTemporalOptions) {
  const seen = new Set<string>(), result: NormalizedTemporalOptions[] = [];
  const add = (historyRadius: Readonly<{min: number; max: number}>, postRadius: number) => {
    const key = `${historyRadius.min}:${historyRadius.max}:${postRadius}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({...options, historyRadius: Object.freeze({...historyRadius}), postRadius});
  };
  let radius = options.historyRadius;
  add(radius, options.postRadius);
  for (const maximum of [8, 4, 2]) {
    if (radius.max <= maximum) continue;
    const min = Math.min(radius.min, maximum);
    radius = {min, max: maximum}; add(radius, options.postRadius);
  }
  for (const postRadius of [2, 1]) if (options.postRadius > postRadius) add(radius, postRadius);
  if (radius.max > 1 || options.postRadius > 0) {
    const minimumHistory = Math.min(1, radius.max);
    add({min: minimumHistory, max: minimumHistory}, 0);
  }
  return result;
}

/** Select the first quality tier that fits the budget and the device's live layer/buffer limits. */
export function planTemporalMemory(width: number, height: number, options: NormalizedTemporalOptions, limits: TemporalMemoryLimits, materialCount=0): TemporalMemoryPlan {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new RangeError('Temporal dimensions must be positive integers.');
  const tiers = candidates(options);
  let minimum = Infinity;
  for (const candidate of tiers) {
    const bytes = estimateTemporalMemory(width, height, candidate, materialCount);
    minimum = Math.min(minimum, bytes);
    if (Number.isSafeInteger(bytes) && layerLimits(width, height, candidate, limits, materialCount) && (options.memoryBudget === undefined || bytes <= options.memoryBudget)) {
      return Object.freeze({historyRadius: candidate.historyRadius, postRadius: candidate.postRadius, bytes});
    }
  }
  if (!Number.isFinite(minimum)) minimum = 0;
  throw new RangeError(`Temporal memory budget or device limits cannot fit the minimum plan (${minimum} bytes).`);
}

export function nextTemporalMemoryPlan(width: number, height: number, options: NormalizedTemporalOptions,
  current: TemporalMemoryPlan, limits: TemporalMemoryLimits, materialCount=0): TemporalMemoryPlan | undefined {
  const tiers = candidates(options);
  const index = tiers.findIndex(candidate => candidate.historyRadius.min === current.historyRadius.min &&
    candidate.historyRadius.max === current.historyRadius.max && candidate.postRadius === current.postRadius);
  if (index < 0) return undefined;
  for (const candidate of tiers.slice(index + 1)) {
    const bytes = estimateTemporalMemory(width, height, candidate, materialCount);
    if (Number.isSafeInteger(bytes) && layerLimits(width, height, candidate, limits, materialCount) && (options.memoryBudget === undefined || bytes <= options.memoryBudget)) {
      return Object.freeze({historyRadius: candidate.historyRadius, postRadius: candidate.postRadius, bytes});
    }
  }
  return undefined;
}

export function temporalMemoryTiers(options: NormalizedTemporalOptions) {
  return candidates(options).map(candidate => ({historyRadius: candidate.historyRadius, postRadius: candidate.postRadius}));
}
