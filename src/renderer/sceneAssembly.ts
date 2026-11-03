import type Geometry from '../scene/Geometry.js';
import type {AnalyticLightState} from '../scene/lightState.js';
import {retainedShaderCapacity} from './shaderCapacity.js';
import {makeRayTraceUniform, packWgpuAnalyticLights} from './wgpuSceneUniform.js';
import {normalizeBounces, MAX_PATH_EVENTS_WEBGL} from './pathLimits.js';
import {normalizeDirectLightCandidates, DEFAULT_BEVEL_SAMPLES} from './renderingLimits.js';
import {samplingPatternCode, zSobolLog2SPP, type SamplingPattern} from './sampling.js';
import {LightChoiceBuffer, buildLightAliasTable, buildShadowCatcherLightAliasTable, estimateAnalyticLightPower, packEmissiveTriangles, packIESProfiles,
  LIGHT_CHOICE_ENVIRONMENT, LIGHT_CHOICE_ANALYTIC, LIGHT_CHOICE_EMISSIVE_TRIANGLE,
  LIGHT_DOMAIN_ENVIRONMENT, LIGHT_DOMAIN_INFINITE, LIGHT_DOMAIN_LOCAL_AND_EMISSIVE,
  type EmissiveTriangle} from './lightSampling.js';

type TraceViews = ReturnType<typeof makeRayTraceUniform>['views'];

export function initialSceneConstants(): Record<string, boolean | number> {
  return {USE_BACKGROUND: false, USE_BACKGROUND_MAP: false, USE_GROUNDED_BACKGROUND: false,
    SAMPLING_PATTERN: 0, BEVEL_SAMPLES: DEFAULT_BEVEL_SAMPLES};
}

export function sceneAttributeLayout(geometry: Geometry) {
  const names = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'materialIndex'] as const;
  const offsets: number[] = [];
  const constants: Record<string, boolean | number> = {USE_UV: geometry.uv != null, USE_VERTEX_COLOR: geometry.color != null};
  let stride = 0;
  for (const name of names) {
    offsets.push(stride); constants[name.toUpperCase() + '_OFF'] = stride / 4;
    if (geometry[name]) stride += 4;
  }
  constants.ATTR_STRIDE = stride / 4;
  return {stride, offsets, constants};
}

export function sceneTraversalConstants(tlas: number, blas: number, previous: Record<string, boolean | number> = {}) {
  return {TLAS_STACK_SIZE: retainedShaderCapacity(tlas, Number(previous.TLAS_STACK_SIZE ?? 0)),
    BLAS_STACK_SIZE: retainedShaderCapacity(blas, Number(previous.BLAS_STACK_SIZE ?? 0), 32)};
}

export function writeTraceQuality(views: TraceViews, options: {bounces: number; bevel: boolean; dispersionWavelengths: 1 | 3; directLightCandidates: number}, maxPathEvents = MAX_PATH_EVENTS_WEBGL) {
  // The AOT caller retains its existing 20-event contract; WebGPU opts into 50.
  views.bounces[0] = normalizeBounces(options.bounces, maxPathEvents);
  views.bevel[0] = Number(options.bevel);
  views.dispersionWavelengths[0] = options.dispersionWavelengths;
  views.directLightCandidates[0] = normalizeDirectLightCandidates(options.directLightCandidates);
}

export function traceSampling(pattern: SamplingPattern, maxSamples: number, sequenceSeed: number) {
  const code = samplingPatternCode(pattern);
  return {code, logSPP: zSobolLog2SPP(code === 1 ? maxSamples - 1 : maxSamples), seed: sequenceSeed >>> 0};
}
export function writeTraceSampling(views: TraceViews, sampling: ReturnType<typeof traceSampling>) {
  views.sequenceSeed[0] = sampling.seed; views.zSobolLogSPP[0] = sampling.logSPP;
}

// The Web path may reuse its choice/texture scratch allocations. Native consumes
// exactly the same assembly without a GPU device, canvas or browser light facade.
export function prepareSceneLightSampling(lights: AnalyticLightState[], emissive: EmissiveTriangle[], environmentPower: number,
  maxDimension: number, choices = new LightChoiceBuffer(), scratch?: Float32Array, catcherChoices?: LightChoiceBuffer) {
  choices.reserve(1 + lights.length + emissive.length);
  choices.push(LIGHT_CHOICE_ENVIRONMENT, 0, environmentPower);
  for (let i = 0; i < lights.length; i++) choices.push(LIGHT_CHOICE_ANALYTIC, i, estimateAnalyticLightPower(lights[i]));
  for (let i = 0; i < emissive.length; i++) choices.push(LIGHT_CHOICE_EMISSIVE_TRIANGLE, i, emissive[i].area * emissive[i].samplingLuminance);
  const distribution = buildLightAliasTable(choices);
  // Without emissive triangles the catcher shares the main table; otherwise
  // its own table follows the main choices in the texture.
  const catcherDistribution = buildShadowCatcherLightAliasTable(choices, catcherChoices);
  const shadowCatcherChoiceOffset = catcherDistribution ? choices.count : 0;
  const shadowCatcherChoiceCount = catcherDistribution ? catcherDistribution.pmfs.length : choices.count;
  const domains = {environment: {count: 0, weight: 0, pmf: 0}, infinite: {count: 0, weight: 0, pmf: 0}, localAndEmissive: {count: 0, weight: 0, pmf: 0}};
  const domainList = [domains.environment, domains.infinite, domains.localAndEmissive];
  const analyticPmfs = new Array<number>(lights.length).fill(0);
  let environmentPmf = 0;
  for (let i = 0; i < choices.count; i++) {
    const type = choices.sourceTypes[i], source = choices.sourceIndices[i], pmf = distribution.pmfs[i];
    const domainIndex = type === LIGHT_CHOICE_ENVIRONMENT ? LIGHT_DOMAIN_ENVIRONMENT :
      type === LIGHT_CHOICE_ANALYTIC && lights[source]?.type === 'DirectionalLight' ? LIGHT_DOMAIN_INFINITE : LIGHT_DOMAIN_LOCAL_AND_EMISSIVE;
    const domain = domainList[domainIndex]; domain.count++; domain.weight += choices.weights[i]; domain.pmf += pmf;
    if (type === LIGHT_CHOICE_ENVIRONMENT) environmentPmf = pmf;
    else if (type === LIGHT_CHOICE_ANALYTIC) analyticPmfs[source] = pmf;
    else emissive[source].selectionPmf = pmf;
  }
  const choiceTexels = Math.max(choices.count + (catcherDistribution ? shadowCatcherChoiceCount : 0), 1);
  const emissiveTexels = emissive.length * 6, profileStart = emissiveTexels + choiceTexels;
  const profiles = packIESProfiles(lights, profileStart), totalTexels = Math.max(profileStart + profiles.texelCount, 1);
  const width = Math.min(maxDimension, Math.max(16, Math.ceil(Math.sqrt(totalTexels) / 16) * 16));
  const height = Math.ceil(totalTexels / width);
  if (height > maxDimension) throw new Error('Too many emissive triangles for the light sampling texture.');
  const lightData = scratch?.length === width * height * 4 ? scratch : new Float32Array(width * height * 4);
  lightData.fill(0);
  if (emissive.length) packEmissiveTriangles(emissive, lightData);
  new Uint32Array(lightData.buffer).set(distribution.choices, emissiveTexels * 4);
  if (catcherDistribution && shadowCatcherChoiceCount) {
    new Uint32Array(lightData.buffer).set(catcherDistribution.choices, (emissiveTexels + choices.count) * 4);
  }
  lightData.set(profiles.data, profileStart * 4);
  return {lightData, lightWidth: width, lightHeight: height, analyticPmfs, profiles, environmentPmf,
    choiceCount: choices.count, totalWeight: distribution.totalWeight, emissiveTexels, domains,
    shadowCatcherChoiceOffset, shadowCatcherChoiceCount};
}

export function writeTraceLighting(views: TraceViews, data: {environmentPmf: number; choiceCount: number; totalWeight: number; lightWidth: number; emissiveTexels: number;
  shadowCatcherChoiceOffset: number; shadowCatcherChoiceCount: number}) {
  views.envLightPmf[0] = data.environmentPmf; views.lightChoiceCount[0] = data.choiceCount;
  views.shadowCatcherChoiceOffset[0] = data.shadowCatcherChoiceOffset; views.shadowCatcherChoiceCount[0] = data.shadowCatcherChoiceCount;
  views.lightWeightTotal[0] = data.totalWeight; views.lightSamplingTextureWidth[0] = data.lightWidth;
  views.lightChoiceTexelOffset[0] = data.emissiveTexels;
}

export function packSceneAnalyticLights(lights: AnalyticLightState[], textureIndices: number[], pmfs: number[], profileOffset: (index: number) => number) {
  return packWgpuAnalyticLights(lights, textureIndices, pmfs, profileOffset);
}
