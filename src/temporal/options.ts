import type {CustomDenoiserOptions, OIDNDenoiserOptions} from '../Render.js';

export type TemporalMode = 'offline' | 'interactive';
export type TemporalHistoryRadius = number | Readonly<{min: number; max: number}>;
export type TemporalSpatialDenoiser = Omit<OIDNDenoiserOptions, 'schedule'> |
  Omit<CustomDenoiserOptions, 'schedule'> | null;

export interface TemporalDenoiserOptions {
  /** Window direction. Default `'offline'`. */
  mode?: TemporalMode;
  /** History radius, from 0 through 32. Default `{min: 8, max: 16}` offline or `17` interactive. */
  historyRadius?: TemporalHistoryRadius;
  /** Stabilisation radius, from 0 through 3. Default `3`. */
  postRadius?: number;
  /** Apply the glint-preserving impulse filter. Default `true`; requires postRadius greater than zero. */
  stabilizeSparkle?: boolean;
  /** Spatial denoiser applied once to the accumulated image. Default OIDN `cleanAuxLarge`. */
  denoiser?: TemporalSpatialDenoiser;
  /** Accumulate albedo and normal for offline OIDN when the history radius is positive. Default `false`. */
  accumulateGuides?: boolean;
  /** Use virtual-image motion for reflected radiance in the offline WebGPU window. Default `false`. */
  reflectionMotion?: boolean;
  /** History invalidation policy. Default `'auto'`. */
  historyInvalidation?: 'auto' | 'manual';
  /** GPU-byte budget for temporal history and scratch. Default `undefined` (full plan). */
  memoryBudget?: number;
}

export interface NormalizedTemporalOptions {
  readonly mode: TemporalMode;
  readonly historyRadius: Readonly<{min: number; max: number}>;
  readonly postRadius: number;
  readonly stabilizeSparkle: boolean;
  readonly denoiser: TemporalSpatialDenoiser;
  readonly accumulateGuides: boolean;
  readonly reflectionMotion: boolean;
  readonly historyInvalidation: 'auto' | 'manual';
  readonly memoryBudget?: number;
}

function integer(value: number, name: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} through ${max}.`);
  return value;
}

export function normalizeTemporalOptions(value: TemporalDenoiserOptions = {}): NormalizedTemporalOptions {
  if (!value || typeof value !== 'object') throw new TypeError('Temporal denoiser options must be an object.');
  const known = new Set(['mode', 'historyRadius', 'postRadius', 'stabilizeSparkle', 'denoiser', 'accumulateGuides', 'reflectionMotion', 'historyInvalidation', 'memoryBudget']);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`Unknown temporal denoiser option ${key}.`);
  const mode = value.mode ?? 'offline';
  if (mode !== 'offline' && mode !== 'interactive') throw new Error("mode must be 'offline' or 'interactive'.");
  const requested = value.historyRadius ?? (mode === 'offline' ? {min: 8, max: 16} : 17);
  let historyRadius: {min: number; max: number};
  if (typeof requested === 'number') {
    const radius = integer(requested, 'historyRadius', 0, 32);
    historyRadius = {min: radius, max: radius};
  } else {
    if (mode !== 'offline') throw new Error('Adaptive historyRadius is available only in offline mode.');
    const min = integer(requested.min, 'historyRadius.min', 0, 32);
    const max = integer(requested.max, 'historyRadius.max', 0, 32);
    if (min > max) throw new RangeError('historyRadius.min must not exceed historyRadius.max.');
    historyRadius = {min, max};
  }
  const postRadius = integer(value.postRadius ?? 3, 'postRadius', 0, 3);
  const stabilizeSparkle = value.stabilizeSparkle ?? true;
  if (typeof stabilizeSparkle !== 'boolean') throw new TypeError('stabilizeSparkle must be a boolean.');
  if (stabilizeSparkle && postRadius === 0) throw new Error('stabilizeSparkle requires postRadius greater than zero.');
  const denoiser = value.denoiser === undefined ? {type: 'oidn' as const, model: 'cleanAuxLarge' as const} : value.denoiser;
  if (denoiser && (denoiser as {type: string}).type === 'jnlm') throw new Error('JNLM cannot denoise a temporal window.');
  if (denoiser && 'schedule' in denoiser) throw new Error('Temporal spatial denoiser schedule is fixed.');
  const accumulateGuides = value.accumulateGuides === undefined ? false : value.accumulateGuides;
  if (typeof accumulateGuides !== 'boolean') throw new TypeError('accumulateGuides must be a boolean.');
  const reflectionMotion = value.reflectionMotion === undefined ? false : value.reflectionMotion;
  if (typeof reflectionMotion !== 'boolean') throw new TypeError('reflectionMotion must be a boolean.');
  const historyInvalidation = value.historyInvalidation ?? 'auto';
  if (historyInvalidation !== 'auto' && historyInvalidation !== 'manual') throw new Error("historyInvalidation must be 'auto' or 'manual'.");
  if (value.memoryBudget !== undefined && (!Number.isSafeInteger(value.memoryBudget) || value.memoryBudget < 0)) throw new RangeError('memoryBudget must be a non-negative safe integer.');
  return Object.freeze({mode, historyRadius: Object.freeze(historyRadius), postRadius, stabilizeSparkle,
    denoiser: denoiser && Object.freeze({...denoiser}), accumulateGuides, reflectionMotion, historyInvalidation, memoryBudget: value.memoryBudget});
}
