import type Render from '../Render.js';
import type { TraceSettings } from '../renderer/renderPipeline.js';
import { normalizeBevelSamples, normalizeDirectLightCandidates } from '../renderer/RenderingPipeline.js';

type Descriptor<K extends keyof Render> = {
  key: K; default: Render[K]; kind: 'image' | 'execution' | 'sample-cap' | 'resolution' | 'denoiser' | 'fallback';
  backends: readonly ('webgpu' | 'webgl')[]; normalize?: (value: Render[K]) => Render[K];
};
const both = ['webgpu', 'webgl'] as const;
// Trace fields are exhaustive: adding a pipeline setting requires a descriptor.
export const traceSchema = {
  aovs: {key: 'aovs', default: [], kind: 'execution', backends: both},
  aovSamples: {key: 'aovSamples', default: 16, kind: 'execution', backends: both},
  bounces: {key: 'bounces', default: 3, kind: 'image', backends: both},
  clamping: {key: 'clamping', default: 0, kind: 'image', backends: both},
  bevel: {key: 'bevel', default: true, kind: 'image', backends: both},
  bevelSamples: {key: 'bevelSamples', default: 8, kind: 'image', backends: both, normalize: normalizeBevelSamples},
  dispersionWavelengths: {key: 'dispersionWavelengths', default: 3, kind: 'image', backends: both},
  caustics: {key: 'caustics', default: undefined, kind: 'image', backends: both},
  directLightCandidates: {key: 'directLightCandidates', default: 4, kind: 'image', backends: ['webgpu'], normalize: normalizeDirectLightCandidates},
  alphaBlendStrategy: {key: 'alphaBlendStrategy', default: 'stochastic', kind: 'image', backends: ['webgpu']},
  transmissiveOutputAlphaMin: {key: 'transmissiveOutputAlphaMin', default: 1, kind: 'image', backends: both},
  samplingPattern: {key: 'samplingPattern', default: 'sobol', kind: 'image', backends: both},
  maxSamples: {key: 'maxSamples', default: 2048, kind: 'sample-cap', backends: both},
  timeBudgetMs: {key: 'timeBudgetMs', default: 21, kind: 'execution', backends: both},
  maxTiles: {key: 'maxTiles', default: Infinity, kind: 'execution', backends: both},
  batchSamples: {key: 'batchSamples', default: false, kind: 'execution', backends: both},
} satisfies {[K in keyof TraceSettings]: Descriptor<K>};
export const renderSchema = [
  ...Object.values(traceSchema),
  {key: 'resolutionScale', default: 1, kind: 'resolution', backends: both},
  {key: 'adaptiveResolution', default: false, kind: 'resolution', backends: both},
  {key: 'fallback', default: null, kind: 'fallback', backends: both},
  {key: 'denoiser', default: null, kind: 'denoiser', backends: both},
] as const;

export function collectTraceSettings(render: Render, sampleCap: number): TraceSettings {
  return Object.fromEntries(Object.values(traceSchema).map(field => [field.key,
    field.key === 'maxSamples' ? sampleCap : 'normalize' in field ? field.normalize(render[field.key]) : render[field.key]
  ])) as unknown as TraceSettings;
}
export function imageSettingsKey(settings: TraceSettings, size: {width: number; height: number}) {
  const fields = Object.values(traceSchema).filter(field => field.kind === 'image');
  return JSON.stringify({...Object.fromEntries(fields.map(field => [field.key, settings[field.key]])),
    samples: settings.samplingPattern === 'zsobol' ? settings.maxSamples : undefined, ...size});
}
