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

function postHistorySlots(options: NormalizedTemporalOptions) {
  if (!options.postRadius) return 0;
  return (options.mode === 'offline' ? 2 : 1) * options.postRadius + 1;
}

export function temporalHistorySlots(options: NormalizedTemporalOptions) {
  const history = options.historyRadius.max, post = options.postRadius;
  // At an offline push, the window center is R frames old. Its earliest
  // post dependency is another 2P frames back (output lag plus past tap).
  return options.mode === 'offline' ? Math.max(2 * history, history + 2 * post) + 1 : Math.max(history, post) + 1;
}

export function usesTemporalGuideWindow(options: NormalizedTemporalOptions) {
  return options.accumulateGuides && options.mode === 'offline' &&
    options.denoiser?.type === 'oidn' && options.historyRadius.max > 0;
}

export function usesTemporalReflectionWindow(options: NormalizedTemporalOptions) {
  return options.reflectionMotion && options.mode === 'offline';
}

export function temporalGuideSlots(options: NormalizedTemporalOptions) {
  // The guide window addresses both textures with the same frame slot.
  if (usesTemporalGuideWindow(options)) return temporalHistorySlots(options);
  return options.mode === 'offline' ? options.historyRadius.max + 1 : 1;
}

/** Exact allocation estimate for the GPU resources owned by temporal history, window and post stages. */
export function estimateTemporalMemory(width: number, height: number, options: NormalizedTemporalOptions, materialCount=0) {
  const pixels = width * height;
  const historySlots = temporalHistorySlots(options);
  const guideSlots = temporalGuideSlots(options);
  const postSlots = postHistorySlots(options);
  const history = historySlots * (pixels * 56 + 80 + overflowBuckets * overflowEntryBytes) + guideSlots * pixels * 16 + 32;
  const window = pixels * (usesTemporalGuideWindow(options) ? 64 : 32) + 112;

  const pyramidBytes = scales.reduce((sum, scale) => sum + ceilDiv(width, scale) * ceilDiv(height, scale) * 8, 0);
  const grids = gridScratchBytes(width, height);
  const post = postSlots ? postSlots * (pixels * 16 + pyramidBytes) + pixels * 76 + grids + 120 : 0;
  const composition = ceilDiv(pixels, 64) * 4 + 16 + (options.stabilizeSparkle && options.postRadius > 0 ? 32 : 0);
  const queuedFrames = TEMPORAL_MAX_FINISHED * pixels * (options.denoiser?.type === 'oidn' ? 96 : 80);
  const postPending = options.mode === 'offline' ? options.postRadius : 0;
  const pendingAndTransient = pixels * (postPending * 64 + 32);
  const customAovs = options.denoiser?.type === 'custom' ? guideSlots * ((options.denoiser.aovs?.length ?? 0) + 2) * pixels * 16 : 0;
  const materialRevisionTable = Math.max(8, materialCount * 8);
  const changedMaterialIds = options.postRadius > 0 ? postSlots * Math.max(8, (materialCount + 1) * 4) : 0;
  // Two history textures, one window sum, the extended center AOV and the beauty sum.
  const reflection = usesTemporalReflectionWindow(options) ? pixels * (24 * historySlots + 64) : 0;
  return history + window + reflection + post + composition + queuedFrames + pendingAndTransient + customAovs + materialRevisionTable + changedMaterialIds;
}

const scales = [2, 4, 8] as const;
function gridScratchBytes(width: number, height: number) {
  const grids = [...scales, ...scales, scales[0], scales[0]];
  return grids.reduce((sum, scale) => sum + ceilDiv(width, scale * 3) * ceilDiv(height, scale * 3) * 8, 0);
}

function layerLimits(width: number, height: number, options: NormalizedTemporalOptions, limits: TemporalMemoryLimits, materialCount: number) {
  if (width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) return false;
  const history = temporalHistorySlots(options);
  const post = postHistorySlots(options);
  if (history * 2 > limits.maxTextureArrayLayers || post > limits.maxTextureArrayLayers) return false;

  const pixels = width * height, image = pixels * 16;
  const overflow = history * overflowBuckets * overflowEntryBytes;
  const grids = [...scales, ...scales, scales[0], scales[0]].map(scale =>
    ceilDiv(width, scale * 3) * ceilDiv(height, scale * 3) * 8);
  const revisionTable = Math.max(8, materialCount * 8);
  const changedMaterialIds = options.postRadius > 0 ? post * Math.max(8, (materialCount + 1) * 4) : 0;
  const buffers = [image, overflow, history * 80, image / 4, ceilDiv(pixels, 64) * 4, revisionTable, changedMaterialIds,
    ...(post ? grids : []), ...(usesTemporalReflectionWindow(options) ? [pixels * 96] : [])];
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
